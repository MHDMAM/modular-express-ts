import { MssqlConfig, MssqlConnector, mssqlConfigFromEnv } from '@libs/Mssql';
import logger from '@utils/logger';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Set when the mocked client library is first imported. */
const library = vi.hoisted(() => ({ loaded: false }));

/** Columns returned by the schema query. */
const schemaRows = [
  { ColumnName: 'email', DataType: 'varchar', MaxLength: 100, TableName: 'users' },
  { ColumnName: 'bio', DataType: 'nvarchar', MaxLength: -1, TableName: 'users' },
  { ColumnName: 'age', DataType: 'int', MaxLength: 4, TableName: 'users' },
];

class FakeRequest {
  inputs: unknown[][] = [];
  outputs: unknown[][] = [];
  input = vi.fn((...args: unknown[]) => (this.inputs.push(args), this));
  output = vi.fn((...args: unknown[]) => (this.outputs.push(args), this));
  query = vi.fn(async (command: string) =>
    command.includes('sys.columns')
      ? { recordset: schemaRows, rowsAffected: [schemaRows.length] }
      : { recordset: [{ id: 1 }], rowsAffected: [1] },
  );
  execute = vi.fn(async (_procedure: string) => ({ recordset: [], rowsAffected: [0], output: {}, returnValue: 0 }));
}

class FakePool extends EventEmitter {
  static last: FakePool;
  connected = false;
  requests: FakeRequest[] = [];
  constructor(public config: unknown) {
    super();
    FakePool.last = this;
  }
  connect = vi.fn(async () => ((this.connected = true), this));
  close = vi.fn(async () => void (this.connected = false));
  request = vi.fn(() => {
    const request = new FakeRequest();
    this.requests.push(request);
    return request;
  });
}

const sqlType = (type: string) => vi.fn((length?: number) => ({ type, length }));

vi.mock('mssql', () => {
  library.loaded = true;
  const sql = {
    ConnectionPool: FakePool,
    VarChar: sqlType('VarChar'),
    NVarChar: sqlType('NVarChar'),
    Int: sqlType('Int'),
  };
  // Like the real package under ES modules: everything is on the default export
  return { default: sql };
});

const baseConfig: MssqlConfig = { enabled: true, server: 'db', database: 'app', user: 'u', password: 'p' };

async function connected() {
  const mssql = new MssqlConnector(baseConfig);
  await mssql.init();
  return mssql;
}

/** The request used by the last statement. */
const lastRequest = () => FakePool.last.requests.at(-1)!;

beforeEach(() => vi.clearAllMocks());

describe('MssqlConnector', () => {
  // Must run first: the library is imported once per test file
  it('does not load the client library until init', async () => {
    const mssql = new MssqlConnector(baseConfig);
    expect(library.loaded).toBe(false);

    await mssql.init();

    expect(library.loaded).toBe(true);
    await mssql.close();
  });

  it('connects with the pool config (without the enabled flag) and is ready', async () => {
    const mssql = await connected();

    expect(FakePool.last.config).toEqual({ server: 'db', database: 'app', user: 'u', password: 'p' });
    expect(FakePool.last.connect).toHaveBeenCalled();
    expect(mssql.isReady()).toBe(true);
  });

  it('logs pool errors instead of crashing the process', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    await connected();

    expect(() => FakePool.last.emit('error', new Error('connection lost'))).not.toThrow();
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ info: 'MSSQL pool error' }));
    error.mockRestore();
  });

  it('types query inputs from the column schema of the given tables', async () => {
    const mssql = await connected();

    const result = await mssql.executeQuery(
      'SELECT * FROM users WHERE email = @email AND bio = @bio AND age = @age AND other = @other',
      { email: 'ada@example.com', bio: 'long text', age: 36, other: 'x' },
      ['users'],
    );

    expect(result.recordset).toEqual([{ id: 1 }]);
    expect(lastRequest().inputs).toEqual([
      ['email', { type: 'VarChar', length: 15 }, 'ada@example.com'],
      ['bio', { type: 'NVarChar', length: 9 }, 'long text'], // MAX column: the value's length
      ['age', { type: 'Int', length: 4 }, 36],
      ['other', 'x'], // not a known column: type inferred by the driver
    ]);
  });

  it('uses explicit TypedValue inputs as given', async () => {
    const mssql = await connected();

    await mssql.executeQuery('SELECT @code', { code: { datatype: 'VarChar', typeLength: 3, value: 'abc' } });

    expect(lastRequest().inputs).toEqual([['code', { type: 'VarChar', length: 3 }, 'abc']]);
  });

  it('executes stored procedures with inputs and typed outputs', async () => {
    const mssql = await connected();

    await mssql.executeSP('usp_create_user', { email: 'a@b.c' }, { id: { datatype: 'Int', value: undefined } }, [
      'users',
    ]);

    const request = lastRequest();
    expect(request.execute).toHaveBeenCalledWith('usp_create_user');
    expect(request.query).not.toHaveBeenCalled();
    expect(request.inputs).toEqual([['email', { type: 'VarChar', length: 5 }, 'a@b.c']]);
    expect(request.outputs).toEqual([['id', { type: 'Int', length: undefined }, undefined]]);
  });

  it('rejects unknown datatypes and untyped outputs', async () => {
    const mssql = await connected();

    await expect(mssql.executeQuery('SELECT 1', { x: { datatype: 'Nope', value: 1 } })).rejects.toThrow(
      'unknown datatype',
    );
    await expect(mssql.executeSP('usp', {}, { id: 1 as any })).rejects.toThrow('needs a TypedValue');
  });

  it('rethrows failed statements and logs them without parameter values', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const mssql = await connected();
    FakePool.last.request.mockImplementationOnce(() => {
      const request = new FakeRequest();
      request.query.mockRejectedValueOnce(new Error('deadlock'));
      return request;
    });

    await expect(mssql.executeQuery('UPDATE users SET email = @email', { email: 'ada@example.com' })).rejects.toThrow(
      'deadlock',
    );

    expect(error).toHaveBeenCalledWith(expect.objectContaining({ info: 'MSSQL statement failed' }));
    expect(JSON.stringify(error.mock.calls)).not.toContain('ada@example.com');
    error.mockRestore();
  });

  it('throws when used before init or after close', async () => {
    const mssql = new MssqlConnector(baseConfig);
    await expect(mssql.executeQuery('SELECT 1')).rejects.toThrow('not ready');

    await mssql.init();
    await mssql.close();

    expect(FakePool.last.close).toHaveBeenCalled();
    expect(mssql.isReady()).toBe(false);
    await expect(mssql.executeQuery('SELECT 1')).rejects.toThrow('not ready');
  });

  it('aborts an init still loading the client when closed', async () => {
    const mssql = new MssqlConnector(baseConfig);
    const pools = FakePool.last;

    const initializing = mssql.init();
    await mssql.close();

    await expect(initializing).rejects.toThrow('closed during init');
    expect(FakePool.last).toBe(pools);
  });
});

describe('mssqlConfigFromEnv', () => {
  it('maps the environment to the pool config', () => {
    const config = mssqlConfigFromEnv({
      MSSQL_ENABLED: 'true',
      MSSQL_SERVER: 'sql.internal',
      MSSQL_PORT: '14330',
      MSSQL_DATABASE: 'orders',
      MSSQL_USER: 'app',
      MSSQL_PASSWORD: 'secret',
      MSSQL_ENCRYPT: 'false',
      MSSQL_TRUST_SERVER_CERTIFICATE: 'true',
      MSSQL_POOL_MAX: '20',
    });

    expect(config).toMatchObject({
      enabled: true,
      server: 'sql.internal',
      port: 14330,
      database: 'orders',
      user: 'app',
      password: 'secret',
      options: { encrypt: false, trustServerCertificate: true },
      pool: { min: 0, max: 20 },
    });
  });

  it('requires a database when enabled', () => {
    expect(() => mssqlConfigFromEnv({ MSSQL_ENABLED: 'true' })).toThrow('MSSQL_DATABASE');
    expect(mssqlConfigFromEnv({}).enabled).toBe(false);
  });
});
