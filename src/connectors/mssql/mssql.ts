import type { ConnectionPool, IProcedureResult, IResult, ISqlType, config as PoolConfig, Request } from 'mssql';
import { z } from 'zod';

import { envBoolean, envNumber, envOptional, envString, parseEnv } from '#config';
import type { Connector } from '#core/lifecycle';
import logger from '#core/logger';

export interface MssqlConfig extends PoolConfig {
  enabled: boolean;
}

/** A parameter with an explicit SQL type, e.g. `{ datatype: 'VarChar', typeLength: 50, value: 'x' }`. */
export interface TypedValue {
  /** Name of one of the driver's type factories (`sql.TYPES`, any case): `VarChar`, `NVarChar`, `Int`, ... */
  datatype: string;
  /**
   * First argument of the type: the length (strings, binary), the precision (`Decimal`, `Numeric`) or the scale
   * (`Time`, `DateTime2`, `DateTimeOffset`).
   */
  typeLength?: number;
  /** Scale of a `Decimal` or `Numeric`. */
  scale?: number;
  value: unknown;
}

interface ColumnRow {
  SchemaName: string;
  ObjectName: string;
  ColumnName: string;
  DataType: string;
  MaxLength: number;
  NumericPrecision: number;
  NumericScale: number;
}

/** A column as declared in the database. */
interface Column {
  /** `schema.table.column`, for error messages. */
  path: string;
  type: ISqlType;
  /** Characters (strings) or bytes (binary) the column holds; undefined when unlimited or not applicable. */
  maxLength?: number;
}

interface Schema {
  /** Columns by lowercase name, of each table and view by lowercase `schema.name`. */
  tables: Map<string, Map<string, Column>>;
  /** The `schema.name` keys sharing a lowercase bare name, to resolve tables given without their schema. */
  qualified: Map<string, string[]>;
}

type TypeFactory = (...args: number[]) => ISqlType;

/** A parameter whose SQL type is resolved. */
class TypedParameter {
  constructor(
    readonly type: ISqlType,
    readonly value: unknown,
  ) {}
}

// Alias types (and `sysname`) are reported as their base type. CLR types (geography, hierarchyid, ...) are left out:
// their parameters need an explicit type.
const SCHEMA_QUERY = `
  SELECT SCHEMA_NAME(obj.schema_id) AS SchemaName, obj.name AS ObjectName, col.name AS ColumnName,
         COALESCE(base.name, typ.name) AS DataType, col.max_length AS MaxLength,
         col.[precision] AS NumericPrecision, col.scale AS NumericScale
  FROM sys.columns col
  INNER JOIN sys.objects obj ON obj.object_id = col.object_id
  INNER JOIN sys.types typ ON typ.user_type_id = col.user_type_id
  LEFT JOIN sys.types base ON base.user_type_id = typ.system_type_id
  WHERE obj.type IN ('U', 'V') AND obj.is_ms_shipped = 0 AND obj.name <> 'sysdiagrams' AND typ.is_assembly_type = 0`;

const emptySchema = (): Schema => ({ tables: new Map(), qualified: new Map() });

function isTypedValue(value: unknown): value is TypedValue {
  return typeof value === 'object' && value !== null && 'datatype' in value && 'value' in value;
}

/** Values the schema can type: everything but tables, arrays and other objects. */
function isScalar(value: unknown): boolean {
  return typeof value !== 'object' || value === null || value instanceof Date || Buffer.isBuffer(value);
}

/**
 * MSSQL connection pool. Once connected it loads, in the background, the declared type of every table and view column,
 * so query inputs named after a column are sent with exactly that column's SQL type (length, precision and scale
 * included). Statements that need the schema wait for it; the others run straight away.
 *
 * ```ts
 * import mssql from '#connectors/mssql/mssql';
 * const { recordset } = await mssql.executeQuery<User>('SELECT * FROM users WHERE email = @email', { email }, ['users']);
 * ```
 */
export class MssqlConnector implements Connector {
  readonly name = 'mssql';
  private pool?: ConnectionPool;
  /** Started by init() and awaited by the statements that need it; cleared when the load fails, so it is retried. */
  private schema?: Promise<Schema>;
  /** The driver's type factories (`sql.TYPES`) by lowercase name: `sys.types` names are lowercase. */
  private types = new Map<string, TypeFactory>();
  /** The driver's length for `(MAX)` types. */
  private max = 0;
  /** Incremented by init() and close(), so an init() still loading the client knows it was closed meanwhile. */
  private generation = 0;

  constructor(private readonly config: MssqlConfig) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  async init(): Promise<void> {
    const generation = ++this.generation;
    // Loaded here, not at import time: a disabled connector never loads the client
    // mssql is CommonJS without detectable named exports: under ES modules only `default` is populated
    const { default: sql } = await import('mssql');
    if (generation !== this.generation) throw new Error('MSSQL connector was closed during init');

    const { enabled: _enabled, ...poolConfig } = this.config;
    const pool = new sql.ConnectionPool(poolConfig);
    pool.on('error', (error) => logger.error({ info: 'MSSQL pool error', error }));
    this.types = new Map(
      Object.entries(sql.TYPES as Record<string, TypeFactory>).map(([name, factory]) => [name.toLowerCase(), factory]),
    );
    this.max = sql.MAX;
    // Assigned before connecting, so close() can stop a connection attempt
    this.pool = pool;
    try {
      await pool.connect();
      if (generation !== this.generation) throw new Error('MSSQL connector was closed during init');
    } catch (error) {
      // Never left half-open: released unless close() or a newer init() already replaced it
      if (this.pool === pool) this.pool = undefined;
      await pool.close().catch(() => undefined);
      throw error;
    }
    // Not awaited: the connector is ready as soon as it is connected
    this.loadedSchema().catch((error) => {
      if (generation === this.generation) logger.error({ info: 'MSSQL schema load failed', error });
    });
  }

  async close(): Promise<void> {
    this.generation++;
    const pool = this.pool;
    this.pool = undefined;
    this.schema = undefined;
    await pool?.close();
  }

  isReady(): boolean {
    return this.pool?.connected ?? false;
  }

  /**
   * Runs a parameterised query (`@name` placeholders). Inputs named after a column of one of `tables` (tables or
   * views, `name` or `schema.name`) are sent with that column's declared type, and rejected when too long for it;
   * `TypedValue` inputs use their explicit type; anything else lets the driver infer the type.
   */
  async executeQuery<T = any>(query: string, inputs: Record<string, unknown> = {}, tables: string[] = []) {
    const typedInputs = await this.typeFromSchema(inputs, tables);
    const request = this.request();
    this.addParameters(request, 'input', typedInputs);
    return this.run<IResult<T>>({ query }, () => request.query<T>(query));
  }

  /** Executes a stored procedure; `outputs` must be `TypedValue`s (the SQL type of each output parameter). */
  async executeSP<T = any>(
    procedure: string,
    inputs: Record<string, unknown> = {},
    outputs: Record<string, TypedValue> = {},
    tables: string[] = [],
  ) {
    const typedInputs = await this.typeFromSchema(inputs, tables);
    const request = this.request();
    this.addParameters(request, 'input', typedInputs);
    this.addParameters(request, 'output', outputs);
    return this.run<IProcedureResult<T>>({ procedure }, () => request.execute<T>(procedure));
  }

  private request(): Request {
    if (!this.config.enabled) throw new Error('MSSQL connector is disabled (set MSSQL_ENABLED=true)');
    if (!this.pool?.connected) throw new Error('MSSQL connector is not ready');
    return this.pool.request();
  }

  /** Runs a statement, logging its duration and outcome; parameter values are not logged (personal data). */
  private async run<R extends IResult<any>>(statement: Record<string, string>, execute: () => Promise<R>): Promise<R> {
    const start = Date.now();
    try {
      const result = await execute();
      logger.debug({
        info: 'MSSQL statement',
        ...statement,
        rowsAffected: result.rowsAffected,
        durationMs: Date.now() - start,
      });
      return result;
    } catch (error) {
      logger.error({ info: 'MSSQL statement failed', ...statement, durationMs: Date.now() - start, error });
      throw error;
    }
  }

  private sqlType(value: TypedValue): ISqlType {
    const factory = this.types.get(value.datatype.toLowerCase());
    if (!factory) throw new Error(`MSSQL: unknown datatype "${value.datatype}"`);
    return factory(...[value.typeLength, value.scale].filter((argument) => argument !== undefined));
  }

  private addParameters(request: Request, kind: 'input' | 'output', parameters: Record<string, unknown>) {
    for (const [name, parameter] of Object.entries(parameters)) {
      const typed = isTypedValue(parameter) ? new TypedParameter(this.sqlType(parameter), parameter.value) : parameter;
      if (typed instanceof TypedParameter) request[kind](name, typed.type, typed.value);
      else if (kind === 'input') request.input(name, typed);
      else throw new Error(`MSSQL: output parameter "${name}" needs a TypedValue`);
    }
  }

  /**
   * Gives the inputs named after a column of `tables` that column's declared type (the first table having the column
   * wins). Explicit `TypedValue`s and non-scalar values are left as they are.
   */
  private async typeFromSchema(inputs: Record<string, unknown>, tables: string[]): Promise<Record<string, unknown>> {
    if (!tables.length) return inputs;
    const schema = await this.loadedSchema();
    const columns = tables.map((table) => this.columnsOf(schema, table));
    return Object.fromEntries(
      Object.entries(inputs).map(([name, value]) => {
        if (isTypedValue(value) || !isScalar(value)) return [name, value];
        const column = columns.map((table) => table.get(name.toLowerCase())).find((found) => found !== undefined);
        if (!column) return [name, value];
        // A value that does not fit would be truncated silently by the declared length
        const length = typeof value === 'string' || Buffer.isBuffer(value) ? value.length : 0;
        if (column.maxLength !== undefined && length > column.maxLength) {
          throw new Error(
            `MSSQL: the value of "${name}" (length ${length}) does not fit ${column.path} (${column.maxLength})`,
          );
        }
        return [name, new TypedParameter(column.type, value)];
      }),
    );
  }

  /** Columns of a table or view, given as `name` or `schema.name` (brackets allowed). */
  private columnsOf(schema: Schema, table: string): Map<string, Column> {
    const name = table.replace(/[[\]"]/g, '').toLowerCase();
    const keys = name.includes('.') ? [name] : (schema.qualified.get(name) ?? []);
    if (keys.length > 1) {
      throw new Error(`MSSQL: table "${table}" exists in several schemas (${keys.join(', ')}): add the schema`);
    }
    const columns = schema.tables.get(keys[0] ?? name);
    if (!columns) throw new Error(`MSSQL: unknown table or view "${table}"`);
    return columns;
  }

  private loadedSchema(): Promise<Schema> {
    if (!this.schema) {
      const load: Promise<Schema> = this.loadSchema().catch((error) => {
        if (this.schema === load) this.schema = undefined;
        throw error;
      });
      this.schema = load;
    }
    return this.schema;
  }

  private async loadSchema(): Promise<Schema> {
    const start = Date.now();
    const { recordset } = await this.executeQuery<ColumnRow>(SCHEMA_QUERY);
    const schema = emptySchema();
    for (const row of recordset) {
      const column = this.column(row);
      // No type factory in the driver (e.g. timestamp): inputs for this column are left to the driver
      if (!column) continue;
      const name = row.ObjectName.toLowerCase();
      const key = `${row.SchemaName.toLowerCase()}.${name}`;
      let columns = schema.tables.get(key);
      if (!columns) {
        schema.tables.set(key, (columns = new Map()));
        schema.qualified.set(name, [...(schema.qualified.get(name) ?? []), key]);
      }
      columns.set(row.ColumnName.toLowerCase(), column);
    }
    logger.info({ info: 'MSSQL schema loaded', tables: schema.tables.size, durationMs: Date.now() - start });
    return schema;
  }

  /** The driver type declared exactly like the column: character length, precision and scale included. */
  private column(row: ColumnRow): Column | undefined {
    const dataType = row.DataType.toLowerCase();
    const factory = this.types.get(dataType);
    if (!factory) return undefined;
    const path = `${row.SchemaName}.${row.ObjectName}.${row.ColumnName}`;
    // max_length is in bytes (two per character for nchar/nvarchar), -1 for (MAX)
    const sized = (bytesPerUnit: number): Column => {
      const maxLength = row.MaxLength < 0 ? undefined : row.MaxLength / bytesPerUnit;
      return { path, type: factory(maxLength ?? this.max), maxLength };
    };
    switch (dataType) {
      case 'nchar':
      case 'nvarchar':
        return sized(2);
      case 'char':
      case 'varchar':
      case 'binary':
      case 'varbinary':
        return sized(1);
      case 'decimal':
      case 'numeric':
        return { path, type: factory(row.NumericPrecision, row.NumericScale) };
      case 'time':
      case 'datetime2':
      case 'datetimeoffset':
        return { path, type: factory(row.NumericScale) };
      default:
        return { path, type: factory() };
    }
  }
}

const mssqlEnv = z
  .object({
    MSSQL_ENABLED: envBoolean(false),
    MSSQL_SERVER: envString('localhost'),
    MSSQL_PORT: envNumber(1433, { min: 1, max: 65535 }),
    MSSQL_DATABASE: envOptional(),
    MSSQL_USER: envOptional(),
    MSSQL_PASSWORD: envOptional(),
    MSSQL_ENCRYPT: envBoolean(true),
    MSSQL_TRUST_SERVER_CERTIFICATE: envBoolean(false),
    MSSQL_POOL_MIN: envNumber(0),
    MSSQL_POOL_MAX: envNumber(10, { min: 1 }),
    MSSQL_REQUEST_TIMEOUT_MS: envNumber(15_000, { min: 1 }),
    MSSQL_CONNECTION_TIMEOUT_MS: envNumber(5_000, { min: 1 }),
  })
  .superRefine((env, ctx) => {
    if (env.MSSQL_ENABLED && !env.MSSQL_DATABASE) {
      ctx.addIssue({ code: 'custom', path: ['MSSQL_DATABASE'], message: 'required when MSSQL_ENABLED is true' });
    }
  })
  .transform((env): MssqlConfig => ({
    enabled: env.MSSQL_ENABLED,
    server: env.MSSQL_SERVER,
    port: env.MSSQL_PORT,
    database: env.MSSQL_DATABASE,
    user: env.MSSQL_USER,
    password: env.MSSQL_PASSWORD,
    requestTimeout: env.MSSQL_REQUEST_TIMEOUT_MS,
    connectionTimeout: env.MSSQL_CONNECTION_TIMEOUT_MS,
    options: {
      encrypt: env.MSSQL_ENCRYPT,
      trustServerCertificate: env.MSSQL_TRUST_SERVER_CERTIFICATE,
      enableArithAbort: true,
    },
    pool: { min: env.MSSQL_POOL_MIN, max: env.MSSQL_POOL_MAX, idleTimeoutMillis: 30_000 },
  }));

/** Reads the `MSSQL_*` environment variables. */
export function mssqlConfigFromEnv(env: Record<string, string | undefined> = process.env): MssqlConfig {
  return parseEnv(mssqlEnv, env);
}

export default new MssqlConnector(mssqlConfigFromEnv());
