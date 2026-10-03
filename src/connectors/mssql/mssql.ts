import type {
  ConnectionPool,
  IProcedureResult,
  IResult,
  ISqlType,
  config as PoolConfig,
  Request,
  Transaction,
} from 'mssql';
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

export interface StatementOptions {
  /** Overrides `MSSQL_REQUEST_TIMEOUT_MS` for this statement. */
  timeoutMs?: number;
}

export type IsolationLevel = 'READ_UNCOMMITTED' | 'READ_COMMITTED' | 'REPEATABLE_READ' | 'SERIALIZABLE' | 'SNAPSHOT';

/** The statements available inside `transaction()`. */
export type MssqlStatements = Pick<MssqlConnector, 'executeQuery' | 'executeSP'>;

interface ColumnRow {
  SchemaName: string;
  ObjectName: string;
  ColumnName: string;
  DataType: string;
  MaxLength: number;
  NumericPrecision: number;
  NumericScale: number;
}

/** A column, or a procedure parameter, as declared in the database. */
interface Column {
  /** `schema.table.column`, for error messages. */
  path: string;
  type: ISqlType;
  /** Characters (strings) or bytes (binary) the column holds; undefined when unlimited or not applicable. */
  maxLength?: number;
}

/** Tables and views with their columns, or procedures with their parameters. */
interface Catalog {
  /** Columns by lowercase name, of each object by lowercase `schema.name`. */
  objects: Map<string, Map<string, Column>>;
  /** The `schema.name` keys sharing a lowercase bare name, to resolve objects given without their schema. */
  qualified: Map<string, string[]>;
}

interface Schema {
  tables: Catalog;
  procedures: Catalog;
}

type TypeFactory = (...args: number[]) => ISqlType;

/** A parameter whose SQL type is resolved. */
class TypedParameter {
  constructor(
    readonly type: ISqlType,
    readonly value: unknown,
  ) {}
}

// Alias types (and `sysname`) are reported as their base type. CLR types (geography, hierarchyid, ...) and table
// types are left out: their parameters need an explicit type.
const typeColumns = (source: string) => `
         COALESCE(base.name, typ.name) AS DataType, ${source}.max_length AS MaxLength,
         ${source}.[precision] AS NumericPrecision, ${source}.scale AS NumericScale`;
const typeJoins = (source: string) => `
  INNER JOIN sys.objects obj ON obj.object_id = ${source}.object_id
  INNER JOIN sys.types typ ON typ.user_type_id = ${source}.user_type_id
  LEFT JOIN sys.types base ON base.user_type_id = typ.system_type_id
  WHERE obj.is_ms_shipped = 0 AND typ.is_assembly_type = 0 AND typ.is_table_type = 0`;

const COLUMNS_QUERY = `
  SELECT SCHEMA_NAME(obj.schema_id) AS SchemaName, obj.name AS ObjectName, col.name AS ColumnName,${typeColumns('col')}
  FROM sys.columns col${typeJoins('col')} AND obj.type IN ('U', 'V') AND obj.name <> 'sysdiagrams'`;

// Parameter names are stored with their @
const PARAMETERS_QUERY = `
  SELECT SCHEMA_NAME(obj.schema_id) AS SchemaName, obj.name AS ObjectName,
         STUFF(par.name, 1, 1, '') AS ColumnName,${typeColumns('par')}
  FROM sys.parameters par${typeJoins('par')} AND obj.type = 'P'`;

function isTypedValue(value: unknown): value is TypedValue {
  return typeof value === 'object' && value !== null && 'datatype' in value && 'value' in value;
}

/** Values the schema can type: everything but tables, arrays and other objects. */
function isScalar(value: unknown): boolean {
  return typeof value !== 'object' || value === null || value instanceof Date || Buffer.isBuffer(value);
}

/**
 * MSSQL connection pool. Once connected it loads, in the background, the declared type of every table and view column
 * and of every procedure parameter, so query inputs named after a column, and procedure parameters, are sent with
 * exactly their declared SQL type (length, precision and scale included). Statements that need the schema wait for it;
 * the others run straight away.
 *
 * ```ts
 * import mssql from '#connectors/mssql/mssql';
 * const { recordset } = await mssql.executeQuery<User>('SELECT * FROM users WHERE email = @email', { email }, ['users']);
 * ```
 */
export class MssqlConnector implements Connector {
  readonly name = 'mssql';
  private driver?: typeof import('mssql');
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
    this.driver = sql;
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
  async executeQuery<T = any>(
    query: string,
    inputs: Record<string, unknown> = {},
    tables: string[] = [],
    options: StatementOptions = {},
  ) {
    return this.query<T>(undefined, query, inputs, tables, options);
  }

  /**
   * Executes a stored procedure (`name` or `schema.name`). Inputs and outputs are sent with the type declared by the
   * procedure, and rejected when too long for it; `TypedValue`s use their explicit type. `outputs` holds each output
   * parameter with its initial value (usually `undefined`). For a procedure that is not in this database's schema,
   * inputs are typed by the driver and outputs must be `TypedValue`s.
   */
  async executeSP<T = any>(
    procedure: string,
    inputs: Record<string, unknown> = {},
    outputs: Record<string, unknown> = {},
    options: StatementOptions = {},
  ) {
    return this.procedure<T>(undefined, procedure, inputs, outputs, options);
  }

  /**
   * Runs `work` in a transaction: committed when it resolves, rolled back when it throws. Its statements share the
   * transaction's single connection, so run them one after the other (no `Promise.all`).
   *
   * ```ts
   * await mssql.transaction(async (tx) => {
   *   await tx.executeQuery('UPDATE accounts SET balance = balance - @amount WHERE id = @from', { amount, from });
   *   await tx.executeQuery('UPDATE accounts SET balance = balance + @amount WHERE id = @to', { amount, to });
   * });
   * ```
   */
  async transaction<R>(work: (tx: MssqlStatements) => Promise<R>, isolationLevel?: IsolationLevel): Promise<R> {
    const transaction = this.connectedPool().transaction();
    const start = Date.now();
    await transaction.begin(isolationLevel && this.driver!.ISOLATION_LEVEL[isolationLevel]);
    try {
      const result = await work({
        executeQuery: (query, inputs, tables, options) => this.query(transaction, query, inputs, tables, options),
        executeSP: (procedure, inputs, outputs, options) =>
          this.procedure(transaction, procedure, inputs, outputs, options),
      });
      await transaction.commit();
      logger.debug({ info: 'MSSQL transaction committed', durationMs: Date.now() - start });
      return result;
    } catch (error) {
      // Fails when the server already aborted the transaction (XACT_ABORT): nothing is left to roll back
      await transaction.rollback().catch(() => undefined);
      logger.debug({ info: 'MSSQL transaction rolled back', durationMs: Date.now() - start });
      throw error;
    }
  }

  private async query<T>(
    transaction: Transaction | undefined,
    query: string,
    inputs: Record<string, unknown> = {},
    tables: string[] = [],
    options: StatementOptions = {},
  ) {
    const typedInputs = this.typed(inputs, await this.tableColumns(tables));
    const request = this.request(transaction, options);
    this.addParameters(request, 'input', typedInputs);
    return this.run<IResult<T>>({ query }, () => request.query<T>(query));
  }

  private async procedure<T>(
    transaction: Transaction | undefined,
    procedure: string,
    inputs: Record<string, unknown> = {},
    outputs: Record<string, unknown> = {},
    options: StatementOptions = {},
  ) {
    const parameters = await this.procedureParameters(procedure, { ...inputs, ...outputs });
    const typedInputs = this.typed(inputs, parameters);
    const typedOutputs = this.typed(outputs, parameters);
    const request = this.request(transaction, options);
    this.addParameters(request, 'input', typedInputs);
    this.addParameters(request, 'output', typedOutputs);
    return this.run<IProcedureResult<T>>({ procedure }, () => request.execute<T>(procedure));
  }

  private connectedPool(): ConnectionPool {
    if (!this.config.enabled) throw new Error('MSSQL connector is disabled (set MSSQL_ENABLED=true)');
    if (!this.pool?.connected) throw new Error('MSSQL connector is not ready');
    return this.pool;
  }

  private request(transaction: Transaction | undefined, { timeoutMs }: StatementOptions): Request {
    const parent = transaction ?? this.connectedPool();
    if (timeoutMs === undefined) return parent.request();
    // The driver's typings lack the constructor's second argument
    const RequestWithOverrides = this.driver!.Request as unknown as new (
      parent: ConnectionPool | Transaction,
      overrides: { requestTimeout: number },
    ) => Request;
    return new RequestWithOverrides(parent, { requestTimeout: timeoutMs });
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
      else throw new Error(`MSSQL: output parameter "${name}" has no known type: pass a TypedValue`);
    }
  }

  /**
   * Gives the parameters named after one of `columns` that column's declared type (the first table having the column
   * wins). Explicit `TypedValue`s and non-scalar values are left as they are.
   */
  private typed(parameters: Record<string, unknown>, columns: Map<string, Column>[]): Record<string, unknown> {
    if (!columns.length) return parameters;
    return Object.fromEntries(
      Object.entries(parameters).map(([name, value]) => {
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

  private async tableColumns(tables: string[]): Promise<Map<string, Column>[]> {
    if (!tables.length) return [];
    const schema = await this.loadedSchema();
    return tables.map((table) => {
      const columns = this.find(schema.tables, 'table or view', table);
      if (!columns) throw new Error(`MSSQL: unknown table or view "${table}"`);
      return columns;
    });
  }

  /** The parameters of a procedure; none when it is not in the schema (another database, a system procedure). */
  private async procedureParameters(
    procedure: string,
    values: Record<string, unknown>,
  ): Promise<Map<string, Column>[]> {
    // The schema is only needed for parameters without an explicit type
    if (Object.values(values).every(isTypedValue)) return [];
    const parameters = this.find((await this.loadedSchema()).procedures, 'procedure', procedure);
    return parameters ? [parameters] : [];
  }

  /** Looks an object up by `name` or `schema.name` (brackets allowed). */
  private find(catalog: Catalog, kind: string, name: string): Map<string, Column> | undefined {
    const key = name.replace(/[[\]"]/g, '').toLowerCase();
    const keys = key.includes('.') ? [key] : (catalog.qualified.get(key) ?? []);
    if (keys.length > 1) {
      throw new Error(`MSSQL: ${kind} "${name}" exists in several schemas (${keys.join(', ')}): add the schema`);
    }
    return catalog.objects.get(keys[0] ?? key);
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
    const columns = await this.executeQuery<ColumnRow>(COLUMNS_QUERY);
    const parameters = await this.executeQuery<ColumnRow>(PARAMETERS_QUERY);
    const schema = { tables: this.catalog(columns.recordset), procedures: this.catalog(parameters.recordset) };
    logger.info({
      info: 'MSSQL schema loaded',
      tables: schema.tables.objects.size,
      procedures: schema.procedures.objects.size,
      durationMs: Date.now() - start,
    });
    return schema;
  }

  private catalog(rows: ColumnRow[]): Catalog {
    const catalog: Catalog = { objects: new Map(), qualified: new Map() };
    for (const row of rows) {
      const column = this.column(row);
      // No type factory in the driver (e.g. timestamp): inputs for this column are left to the driver
      if (!column) continue;
      const name = row.ObjectName.toLowerCase();
      const key = `${row.SchemaName.toLowerCase()}.${name}`;
      let columns = catalog.objects.get(key);
      if (!columns) {
        catalog.objects.set(key, (columns = new Map()));
        catalog.qualified.set(name, [...(catalog.qualified.get(name) ?? []), key]);
      }
      columns.set(row.ColumnName.toLowerCase(), column);
    }
    return catalog;
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
