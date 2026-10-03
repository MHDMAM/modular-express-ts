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
  /** How often the server is pinged for `isReady()`; 0 or undefined disables it. */
  healthCheckIntervalMs?: number;
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
export type MssqlStatements = Pick<MssqlConnector, 'executeQuery' | 'executeSP' | 'streamQuery'>;

interface ColumnRow {
  SchemaName: string;
  ObjectName: string;
  ColumnName: string;
  DataType: string;
  MaxLength: number;
  NumericPrecision: number;
  NumericScale: number;
  /** Code page of the column's collation; null for other types and for procedure parameters. */
  CodePage: number | null;
}

/** A column, or a procedure parameter, as declared in the database. */
interface Column {
  /** `schema.table.column`, for error messages. */
  path: string;
  type: ISqlType;
  /** Characters (strings) or bytes (binary) the column holds; undefined when unlimited or not applicable. */
  maxLength?: number;
  /** `binary(n)`: shorter values are zero-padded to `n`, as the server stores them. */
  fixedBinary?: boolean;
  /** `char`, `varchar` and `text`: stored in a code page, so `maxLength` is in bytes of that code page. */
  encoded?: {
    /** The collation's code page; undefined for the database's own (procedure parameters). */
    codePage?: number;
    /** The same length as a Unicode type, for text the database's code page cannot carry. */
    unicode: ISqlType;
  };
}

/**
 * Names looked up as written, then ignoring case when that leaves a single candidate: a case-insensitive database
 * finds a name whatever its case, a case-sensitive one can hold names that differ only by case.
 */
class Names<T> {
  private exact = new Map<string, T>();
  /** By lowercase name; `undefined` once two names share it. */
  private folded = new Map<string, T | undefined>();

  get size(): number {
    return this.exact.size;
  }

  exactly(name: string): T | undefined {
    return this.exact.get(name);
  }

  get(name: string): T | undefined {
    return this.exact.get(name) ?? this.folded.get(name.toLowerCase());
  }

  set(name: string, value: T): void {
    const key = name.toLowerCase();
    this.folded.set(key, this.folded.has(key) && !this.exact.has(name) ? undefined : value);
    this.exact.set(name, value);
  }
}

/** The columns of each table and view (or the parameters of each procedure) by `schema.name`. */
type Catalog = Names<Names<Column>>;

interface Schema {
  tables: Catalog;
  procedures: Catalog;
  /** Where a name without schema is looked up, as the server does: the user's default schema, then `dbo`. */
  defaultSchemas: string[];
  /** Code page of the database's collation: the one the driver encodes `char` and `varchar` parameters in. */
  codePage?: number;
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
  SELECT SCHEMA_NAME(obj.schema_id) AS SchemaName, obj.name AS ObjectName, col.name AS ColumnName,
         CAST(COLLATIONPROPERTY(col.collation_name, 'CodePage') AS int) AS CodePage,${typeColumns('col')}
  FROM sys.columns col${typeJoins('col')} AND obj.type IN ('U', 'V') AND obj.name <> 'sysdiagrams'`;

// Parameter names are stored with their @
const PARAMETERS_QUERY = `
  SELECT SCHEMA_NAME(obj.schema_id) AS SchemaName, obj.name AS ObjectName,
         STUFF(par.name, 1, 1, '') AS ColumnName, CAST(NULL AS int) AS CodePage,${typeColumns('par')}
  FROM sys.parameters par${typeJoins('par')} AND obj.type = 'P'`;

const DATABASE_QUERY = `
  SELECT SCHEMA_NAME() AS DefaultSchema,
         CAST(COLLATIONPROPERTY(CAST(DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS nvarchar(128)), 'CodePage') AS int)
           AS CodePage`;

const UTF8 = 65001;
/** Code pages with one or two bytes per character (Japanese, Chinese, Korean): byte lengths are not computed. */
const DOUBLE_BYTE = [932, 936, 949, 950];
const ASCII = /^[\x00-\x7f]*$/;

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
  /** The last schema loaded; kept in use while a refresh is running. */
  private schema?: Schema;
  /** The load in progress, shared by everything waiting for it. */
  private schemaLoad?: Promise<Schema>;
  /** The driver's type factories (`sql.TYPES`) by lowercase name: `sys.types` names are lowercase. */
  private types = new Map<string, TypeFactory>();
  /** The driver's length for `(MAX)` types. */
  private max = 0;
  /** False once a health check failed, until one succeeds again. */
  private healthy = true;
  private healthTimer?: NodeJS.Timeout;
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

    const { enabled: _enabled, healthCheckIntervalMs, ...poolConfig } = this.config;
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
    this.healthy = true;
    this.startHealthChecks(pool, healthCheckIntervalMs);
    // Not awaited: the connector is ready as soon as it is connected
    this.loadSchemaOnce().catch((error) => {
      if (generation === this.generation) logger.error({ info: 'MSSQL schema load failed', error });
    });
  }

  async close(): Promise<void> {
    this.generation++;
    clearInterval(this.healthTimer);
    const pool = this.pool;
    this.pool = undefined;
    this.schema = undefined;
    this.schemaLoad = undefined;
    await pool?.close();
  }

  isReady(): boolean {
    return (this.pool?.connected ?? false) && this.healthy;
  }

  /**
   * Runs a parameterised query (`@name` placeholders). Inputs named after a column of one of `tables` (tables or
   * views, `schema.name`, or `name` for those the server finds without a schema) are sent with that column's declared
   * type, and rejected when too long for it; `TypedValue` inputs use their explicit type; anything else lets the
   * driver infer the type.
   */
  async executeQuery<T = unknown>(
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
  async executeSP<T = unknown>(
    procedure: string,
    inputs: Record<string, unknown> = {},
    outputs: Record<string, unknown> = {},
    options: StatementOptions = {},
  ) {
    return this.procedure<T>(undefined, procedure, inputs, outputs, options);
  }

  /**
   * Like `executeQuery`, for results too large to hold in memory: yields the rows one by one as the server sends them,
   * pausing the driver while the consumer is busy. Leaving the loop early cancels the query.
   *
   * ```ts
   * for await (const order of mssql.streamQuery<Order>('SELECT * FROM orders WHERE year = @year', { year })) { ... }
   * ```
   */
  streamQuery<T = unknown>(
    query: string,
    inputs: Record<string, unknown> = {},
    tables: string[] = [],
    options: StatementOptions = {},
  ): AsyncGenerator<T, void, undefined> {
    return this.stream<T>(undefined, query, inputs, tables, options);
  }

  /**
   * Reloads the schema, e.g. after a migration changed a table or a procedure. The previous schema stays in use until
   * the new one is loaded; a load already in progress is awaited instead of starting another.
   */
  async refreshSchema(): Promise<void> {
    await this.loadSchemaOnce();
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
        streamQuery: (query, inputs, tables, options) => this.stream(transaction, query, inputs, tables, options),
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
    const typedInputs = await this.typedFromTables(inputs, tables);
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
    const [typedInputs, typedOutputs] = await this.typedFromProcedure(procedure, inputs, outputs);
    const request = this.request(transaction, options);
    this.addParameters(request, 'input', typedInputs);
    this.addParameters(request, 'output', typedOutputs);
    return this.run<IProcedureResult<T>>({ procedure }, () => request.execute<T>(procedure));
  }

  private async *stream<T>(
    transaction: Transaction | undefined,
    query: string,
    inputs: Record<string, unknown> = {},
    tables: string[] = [],
    options: StatementOptions = {},
  ): AsyncGenerator<T, void, undefined> {
    const typedInputs = await this.typedFromTables(inputs, tables);
    const request = this.request(transaction, options);
    this.addParameters(request, 'input', typedInputs);
    const rows = request.toReadableStream();
    const start = Date.now();
    let count = 0;
    let done = false;
    request.once('done', () => (done = true));
    // In stream mode the promise always resolves: failures are emitted on the stream
    void request.query(query);
    try {
      for await (const row of rows) {
        count++;
        yield row as T;
      }
      logger.debug({ info: 'MSSQL statement', query, rows: count, durationMs: Date.now() - start });
    } catch (error) {
      logger.error({ info: 'MSSQL statement failed', query, rows: count, durationMs: Date.now() - start, error });
      throw error;
    } finally {
      // The consumer left the loop early: stop the query instead of letting the server send the rest
      if (!done) request.cancel();
    }
  }

  /**
   * Pings the server regularly: the pool only notices that its server went away when a statement needs a connection,
   * so without traffic it would report itself connected forever.
   */
  private startHealthChecks(pool: ConnectionPool, intervalMs = 0): void {
    clearInterval(this.healthTimer);
    if (intervalMs <= 0) return;
    let checking = false;
    const check = async () => {
      if (checking || this.pool !== pool) return;
      checking = true;
      try {
        await this.request(undefined, { timeoutMs: Math.min(intervalMs, 5_000) }).query('SELECT 1');
        this.healthy = true;
      } catch {
        // Not logged here: the connector monitor reports the change of status
        this.healthy = false;
      } finally {
        checking = false;
      }
    };
    // Does not keep the process alive
    this.healthTimer = setInterval(check, intervalMs).unref();
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
  private typed(
    parameters: Record<string, unknown>,
    columns: Names<Column>[],
    databaseCodePage?: number,
  ): Record<string, unknown> {
    if (!columns.length) return parameters;
    return Object.fromEntries(
      Object.entries(parameters).map(([name, value]) => {
        if (isTypedValue(value) || !isScalar(value)) return [name, value];
        const column = columns.map((table) => table.get(name)).find((found) => found !== undefined);
        if (!column) return [name, value];
        let type = column.type;
        let length = typeof value === 'string' || Buffer.isBuffer(value) ? value.length : 0;
        if (typeof value === 'string' && column.encoded && !ASCII.test(value)) {
          const codePage = column.encoded.codePage ?? databaseCodePage;
          // The driver encodes char and varchar parameters in the database's code page: sent that way to a column of
          // another code page, the characters the database's lacks arrive as "?"
          if (codePage !== databaseCodePage) type = column.encoded.unicode;
          if (codePage === UTF8) length = Buffer.byteLength(value);
          else if (codePage !== undefined && DOUBLE_BYTE.includes(codePage)) length = 0;
        }
        // A value that does not fit would be truncated silently by the declared length
        if (column.maxLength !== undefined && length > column.maxLength) {
          throw new Error(
            `MSSQL: the value of "${name}" (length ${length}) does not fit ${column.path} (${column.maxLength})`,
          );
        }
        // The driver sends a binary(n) value shorter than n as a broken packet, which the server rejects
        const padded = column.fixedBinary && Buffer.isBuffer(value) ? Buffer.concat([value], column.maxLength) : value;
        return [name, new TypedParameter(type, padded)];
      }),
    );
  }

  private async typedFromTables(inputs: Record<string, unknown>, tables: string[]): Promise<Record<string, unknown>> {
    if (!tables.length) return inputs;
    const schema = await this.loadedSchema();
    const columns = tables.map((table) => {
      const found = this.find(schema.tables, schema.defaultSchemas, table);
      if (!found) throw new Error(`MSSQL: unknown table or view "${table}"`);
      return found;
    });
    return this.typed(inputs, columns, schema.codePage);
  }

  /** Inputs and outputs left as they are when the procedure is not in the schema (another database, a system one). */
  private async typedFromProcedure(
    procedure: string,
    inputs: Record<string, unknown>,
    outputs: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    // The schema is only needed for parameters without an explicit type
    if ([...Object.values(inputs), ...Object.values(outputs)].every(isTypedValue)) return [inputs, outputs];
    const schema = await this.loadedSchema();
    const parameters = this.find(schema.procedures, schema.defaultSchemas, procedure);
    const columns = parameters ? [parameters] : [];
    return [this.typed(inputs, columns, schema.codePage), this.typed(outputs, columns, schema.codePage)];
  }

  /**
   * Looks an object up by `schema.name` or `name` (brackets allowed). A name without schema is resolved like the
   * server resolves it in a statement: in the user's default schema, then in `dbo`.
   */
  private find(catalog: Catalog, defaultSchemas: string[], name: string): Names<Column> | undefined {
    const key = name.replace(/[[\]"]/g, '');
    const keys = key.includes('.') ? [key] : defaultSchemas.map((schema) => `${schema}.${key}`);
    return keys.map((candidate) => catalog.get(candidate)).find((found) => found !== undefined);
  }

  /** The schema: loaded by init() in the background, or now when that load failed or has not finished. */
  private async loadedSchema(): Promise<Schema> {
    return this.schema ?? this.loadSchemaOnce();
  }

  private loadSchemaOnce(): Promise<Schema> {
    if (!this.schemaLoad) {
      // Ignored when close() or a newer init() replaced it meanwhile
      const load: Promise<Schema> = this.loadSchema()
        .then((schema) => {
          if (this.schemaLoad === load) this.schema = schema;
          return schema;
        })
        .finally(() => {
          if (this.schemaLoad === load) this.schemaLoad = undefined;
        });
      this.schemaLoad = load;
    }
    return this.schemaLoad;
  }

  private async loadSchema(): Promise<Schema> {
    const start = Date.now();
    const columns = await this.executeQuery<ColumnRow>(COLUMNS_QUERY);
    const parameters = await this.executeQuery<ColumnRow>(PARAMETERS_QUERY);
    const database = await this.executeQuery<{ DefaultSchema: string | null; CodePage: number | null }>(DATABASE_QUERY);
    const defaultSchema = database.recordset[0]?.DefaultSchema ?? 'dbo';
    const schema = {
      tables: this.catalog(columns.recordset),
      procedures: this.catalog(parameters.recordset),
      defaultSchemas: [...new Set([defaultSchema, 'dbo'])],
      codePage: database.recordset[0]?.CodePage ?? undefined,
    };
    logger.info({
      info: 'MSSQL schema loaded',
      tables: schema.tables.size,
      procedures: schema.procedures.size,
      defaultSchema,
      durationMs: Date.now() - start,
    });
    return schema;
  }

  private catalog(rows: ColumnRow[]): Catalog {
    const catalog: Catalog = new Names();
    for (const row of rows) {
      const column = this.column(row);
      // No type factory in the driver (e.g. timestamp): inputs for this column are left to the driver
      if (!column) continue;
      const key = `${row.SchemaName}.${row.ObjectName}`;
      let columns = catalog.exactly(key);
      if (!columns) catalog.set(key, (columns = new Names()));
      columns.set(row.ColumnName, column);
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
    const encoded = (maxLength?: number): Column['encoded'] => ({
      codePage: row.CodePage ?? undefined,
      unicode: this.types.get('nvarchar')!(maxLength ?? this.max),
    });
    switch (dataType) {
      case 'nchar':
      case 'nvarchar':
        return sized(2);
      case 'binary':
        return { ...sized(1), fixedBinary: true };
      case 'char':
      case 'varchar': {
        const column = sized(1);
        return { ...column, encoded: encoded(column.maxLength) };
      }
      case 'text':
        return { path, type: factory(), encoded: encoded() };
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
    MSSQL_HEALTH_CHECK_INTERVAL_MS: envNumber(10_000, { min: 0 }),
  })
  .superRefine((env, ctx) => {
    if (env.MSSQL_ENABLED && !env.MSSQL_DATABASE) {
      ctx.addIssue({ code: 'custom', path: ['MSSQL_DATABASE'], message: 'required when MSSQL_ENABLED is true' });
    }
  })
  .transform((env): MssqlConfig => ({
    enabled: env.MSSQL_ENABLED,
    healthCheckIntervalMs: env.MSSQL_HEALTH_CHECK_INTERVAL_MS,
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
