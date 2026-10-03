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
  typeLength?: number;
  value: unknown;
}

interface ColumnDetails {
  ColumnName: string;
  DataType: string;
  MaxLength: number;
  TableName: string;
}

type TypeFactory = (...args: number[]) => ISqlType;

const SCHEMA_QUERY = `
  SELECT col.name AS ColumnName, types.name AS DataType, col.max_length AS MaxLength, tbl.name AS TableName
  FROM sys.columns col WITH (NOLOCK)
  INNER JOIN sys.types types WITH (NOLOCK) ON col.user_type_id = types.user_type_id
  LEFT OUTER JOIN sys.tables tbl WITH (NOLOCK) ON tbl.object_id = col.object_id
  WHERE tbl.name IS NOT NULL AND tbl.name <> 'sysdiagrams'
  ORDER BY tbl.name`;

function isTypedValue(value: unknown): value is TypedValue {
  return typeof value === 'object' && value !== null && 'datatype' in value && 'value' in value;
}

/**
 * MSSQL connection pool. On init it loads the column types of every table, so query inputs named after a column get
 * that column's SQL type and length automatically.
 *
 * ```ts
 * import mssql from '#connectors/mssql/mssql';
 * const { recordset } = await mssql.executeQuery<User>('SELECT * FROM users WHERE email = @email', { email }, ['users']);
 * ```
 */
export class MssqlConnector implements Connector {
  readonly name = 'mssql';
  private pool?: ConnectionPool;
  private schema: Record<string, ColumnDetails[]> = {};
  /** The driver's type factories (`sql.TYPES`) by lowercase name: `sys.types` names are lowercase. */
  private types = new Map<string, { name: string; factory: TypeFactory }>();
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
      Object.entries(sql.TYPES as Record<string, TypeFactory>).map(([name, factory]) => [
        name.toLowerCase(),
        { name, factory },
      ]),
    );
    this.pool = pool;
    await pool.connect();
    this.schema = await this.loadSchema();
  }

  async close(): Promise<void> {
    this.generation++;
    const pool = this.pool;
    this.pool = undefined;
    this.schema = {};
    await pool?.close();
  }

  isReady(): boolean {
    return this.pool?.connected ?? false;
  }

  /**
   * Runs a parameterised query (`@name` placeholders). Inputs named after a column of one of `tables` are typed from
   * the schema; `TypedValue` inputs use their explicit type; anything else lets the driver infer the type.
   */
  async executeQuery<T = any>(query: string, inputs: Record<string, unknown> = {}, tables: string[] = []) {
    const request = this.request();
    this.addParameters(request, 'input', this.typeFromSchema(inputs, tables));
    return this.run<IResult<T>>({ query }, () => request.query<T>(query));
  }

  /** Executes a stored procedure; `outputs` must be `TypedValue`s (the SQL type of each output parameter). */
  async executeSP<T = any>(
    procedure: string,
    inputs: Record<string, unknown> = {},
    outputs: Record<string, TypedValue> = {},
    tables: string[] = [],
  ) {
    const request = this.request();
    this.addParameters(request, 'input', this.typeFromSchema(inputs, tables));
    this.addParameters(request, 'output', outputs);
    return this.run<IProcedureResult<T>>({ procedure }, () => request.execute<T>(procedure));
  }

  private request(): Request {
    if (!this.pool) throw new Error('MSSQL connector is not ready');
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
    const type = this.types.get(value.datatype.toLowerCase());
    if (!type) throw new Error(`MSSQL: unknown datatype "${value.datatype}"`);
    return value.typeLength === undefined ? type.factory() : type.factory(value.typeLength);
  }

  private addParameters(request: Request, kind: 'input' | 'output', parameters: Record<string, unknown>) {
    for (const [name, value] of Object.entries(parameters)) {
      if (isTypedValue(value)) {
        if (kind === 'input') request.input(name, this.sqlType(value), value.value);
        else request.output(name, this.sqlType(value), value.value);
      } else if (kind === 'input') {
        request.input(name, value);
      } else {
        throw new Error(`MSSQL: output parameter "${name}" needs a TypedValue`);
      }
    }
  }

  private typeFromSchema(inputs: Record<string, unknown>, tables: string[]): Record<string, unknown> {
    const columns = tables.flatMap((table) => this.schema[table] ?? []);
    return Object.fromEntries(
      Object.entries(inputs).map(([name, value]) => {
        const column = columns.find((c) => c.ColumnName === name);
        if (!column || isTypedValue(value) || (typeof value === 'object' && value !== null)) return [name, value];
        const length = typeof value === 'string' ? value.length : undefined;
        // MaxLength is -1 for (N)VARCHAR(MAX): use the value's length
        const typeLength = column.MaxLength < 0 ? length : Math.min(length ?? column.MaxLength, column.MaxLength);
        return [name, { datatype: column.DataType, typeLength, value } satisfies TypedValue];
      }),
    );
  }

  private async loadSchema(): Promise<Record<string, ColumnDetails[]>> {
    const { recordset } = await this.executeQuery<ColumnDetails>(SCHEMA_QUERY);
    const schema: Record<string, ColumnDetails[]> = {};
    for (const column of recordset) {
      const type = this.types.get(column.DataType.toLowerCase())?.name ?? column.DataType;
      (schema[column.TableName] ??= []).push({ ...column, DataType: type });
    }
    return schema;
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
