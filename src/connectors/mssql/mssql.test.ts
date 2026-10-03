import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import logger from '#core/logger';

import { MssqlConfig, mssqlConfigFromEnv, MssqlConnector } from './mssql.js';

/** Set when the mocked client library is first imported. */
const library = vi.hoisted(() => ({ loaded: false }));

/** Columns returned by the schema query. */
const column = (
  table: string,
  name: string,
  type: string,
  maxLength: number,
  precision = 0,
  scale = 0,
  codePage: number | null = null,
) => {
  const [SchemaName, ObjectName] = table.split('.');
  return {
    SchemaName,
    ObjectName,
    ColumnName: name,
    DataType: type,
    MaxLength: maxLength,
    NumericPrecision: precision,
    NumericScale: scale,
    CodePage: codePage ?? (type === 'varchar' && table.startsWith('dbo.') && !table.includes('usp_') ? 1252 : null),
  };
};

/** Columns returned by the schema query, as `sys.columns` reports them (`max_length` in bytes). */
const schemaRows = [
  column('dbo.users', 'email', 'varchar', 100),
  column('dbo.users', 'name', 'nvarchar', 100), // nvarchar(50)
  column('dbo.users', 'bio', 'nvarchar', -1), // nvarchar(MAX)
  column('dbo.users', 'age', 'int', 4, 10, 0),
  column('dbo.users', 'balance', 'decimal', 9, 18, 4),
  column('dbo.users', 'created_at', 'datetime2', 8, 27, 7),
  column('dbo.users', 'avatar', 'varbinary', 4),
  column('dbo.users', 'pin_hash', 'binary', 4),
  column('dbo.users', 'version', 'timestamp', 8), // no type factory in the driver
  column('dbo.orders', 'id', 'int', 4, 10, 0),
  column('audit.orders', 'id', 'bigint', 8, 19, 0),
  column('audit.trail', 'id', 'bigint', 8, 19, 0),
  // varchar columns in other code pages than the database's (1252)
  column('dbo.texts', 'utf8', 'varchar', 10, 0, 0, 65001),
  column('dbo.texts', 'latin', 'varchar', 10, 0, 0, 1252),
  column('dbo.texts', 'jp', 'varchar', 10, 0, 0, 932),
  // Names differing only by case, as a case-sensitive database allows
  column('dbo.Accounts', 'Name', 'varchar', 10),
  column('dbo.Accounts', 'name', 'varchar', 20),
  column('dbo.accounts', 'id', 'int', 4, 10, 0),
];

/** Parameters returned by the procedure parameters query. */
const parameterRows = [
  column('dbo.usp_create_user', 'email', 'varchar', 100),
  column('dbo.usp_create_user', 'balance', 'decimal', 9, 18, 4),
  column('dbo.usp_create_user', 'id', 'int', 4, 10, 0),
  column('dbo.usp_create_user', 'code', 'nvarchar', 20),
];

class FakeRequest extends EventEmitter {
  /** Set when created through the driver's `Request` constructor (statements with their own timeout). */
  overrides?: unknown;
  /** The connected user's default schema, as returned with the schema. */
  static defaultSchema: string | null = 'dbo';
  /** Set to make the health check's ping fail, like a server that went away. */
  static down = false;
  /** Rows of a streamed query; an `Error` among them fails the stream at that point. */
  static streamed: unknown[] = [];
  /** Like the driver: rows are pushed to the stream, then `done` is emitted (after an error too). */
  toReadableStream = vi.fn(() => {
    const emitDone = () => this.emit('done');
    return Readable.from(
      (async function* () {
        for (const row of FakeRequest.streamed) {
          if (row instanceof Error) {
            emitDone();
            throw row;
          }
          yield row;
        }
        emitDone();
      })(),
    );
  });
  cancel = vi.fn();
  inputs: unknown[][] = [];
  outputs: unknown[][] = [];
  input = vi.fn((...args: unknown[]) => (this.inputs.push(args), this));
  output = vi.fn((...args: unknown[]) => (this.outputs.push(args), this));
  query = vi.fn(async (command: string) => {
    if (command === 'SELECT 1' && FakeRequest.down) throw new Error('ESOCKET');
    return this.result(command);
  });
  result = (command: string) =>
    command.includes('sys.columns')
      ? { recordset: schemaRows, rowsAffected: [schemaRows.length] }
      : command.includes('sys.parameters')
        ? { recordset: parameterRows, rowsAffected: [parameterRows.length] }
        : command.includes('AS DefaultSchema')
          ? { recordset: [{ DefaultSchema: FakeRequest.defaultSchema, CodePage: 1252 }], rowsAffected: [1] }
          : { recordset: [{ id: 1 }], rowsAffected: [1] };
  execute = vi.fn(async (_procedure: string) => ({ recordset: [], rowsAffected: [0], output: {}, returnValue: 0 }));
}

class FakeTransaction {
  constructor(private pool: FakePool) {}
  begin = vi.fn(async (_isolationLevel?: number) => this);
  commit = vi.fn(async () => {});
  rollback = vi.fn(async () => {});
  request = vi.fn(() => this.pool.request());
}

class FakePool extends EventEmitter {
  static last: FakePool;
  connected = false;
  requests: FakeRequest[] = [];
  constructor(public config: unknown) {
    super();
    FakePool.last = this;
  }
  /** On the prototype, so a test can make the next pool's connection fail or wait. */
  async connectOnce(): Promise<void> {}
  newRequest(): FakeRequest {
    return new FakeRequest();
  }
  connect = vi.fn(async () => {
    await this.connectOnce();
    this.connected = true;
    return this;
  });
  close = vi.fn(async () => void (this.connected = false));
  transactions: FakeTransaction[] = [];
  transaction = vi.fn(() => {
    const transaction = new FakeTransaction(this);
    this.transactions.push(transaction);
    return transaction;
  });
  request = vi.fn(() => {
    const request = this.newRequest();
    this.requests.push(request);
    return request;
  });
}

const sqlType = (type: string) => vi.fn((...args: number[]) => ({ type, args }));
const typeNames = ['VarChar', 'NVarChar', 'Int', 'BigInt', 'Decimal', 'DateTime2', 'VarBinary', 'Binary'];

vi.mock('mssql', () => {
  library.loaded = true;
  const sql = {
    ConnectionPool: FakePool,
    Request: class extends FakeRequest {
      constructor(parent: FakePool | FakeTransaction, overrides: unknown) {
        super();
        this.overrides = overrides;
        (parent instanceof FakePool ? parent : FakePool.last).requests.push(this);
      }
    },
    ISOLATION_LEVEL: { READ_COMMITTED: 2, SERIALIZABLE: 4 },
    TYPES: Object.fromEntries(typeNames.map((name) => [name, sqlType(name)])),
    MAX: 65535,
  };
  // Like the real package under ES modules: everything is on the default export
  return { default: sql };
});

const baseConfig: MssqlConfig = { enabled: true, server: 'db', database: 'app', user: 'u', password: 'p' };

/** A connected connector; by default its background schema load (three queries) has finished too. */
async function connected({ schemaLoaded = true } = {}) {
  const mssql = new MssqlConnector(baseConfig);
  await mssql.init();
  if (schemaLoaded) {
    const loaded = () => expect(FakePool.last.requests.at(2)?.query.mock.results[0]?.type).toBe('return');
    await vi.waitFor(loaded, { interval: 1 });
  }
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

  it('types query inputs exactly like the columns of the given tables', async () => {
    const mssql = await connected();
    const createdAt = new Date();

    const result = await mssql.executeQuery(
      'UPDATE users SET name = @name, bio = @bio, balance = @balance, created_at = @created_at WHERE email = @Email',
      { Email: 'ada@example.com', name: 'Ada', bio: 'long text', balance: 12.5, created_at: createdAt, age: null },
      ['users'],
    );

    expect(result.recordset).toEqual([{ id: 1 }]);
    expect(lastRequest().inputs).toEqual([
      ['Email', { type: 'VarChar', args: [100] }, 'ada@example.com'], // the declared length, not the value's
      ['name', { type: 'NVarChar', args: [50] }, 'Ada'], // characters, not bytes
      ['bio', { type: 'NVarChar', args: [65535] }, 'long text'], // MAX
      ['balance', { type: 'Decimal', args: [18, 4] }, 12.5],
      ['created_at', { type: 'DateTime2', args: [7] }, createdAt],
      ['age', { type: 'Int', args: [] }, null],
    ]);
  });

  it('leaves the type to the driver for unknown columns, unsupported types and non-scalar values', async () => {
    const mssql = await connected();
    const list = [1, 2];

    await mssql.executeQuery('SELECT 1', { other: 'x', version: 'abc', age: list }, ['dbo.users']);

    expect(lastRequest().inputs).toEqual([
      ['other', 'x'],
      ['version', 'abc'],
      ['age', list],
    ]);
  });

  it('rejects values longer than their column', async () => {
    const mssql = await connected();

    await expect(mssql.executeQuery('SELECT 1', { name: 'x'.repeat(51) }, ['users'])).rejects.toThrow(
      'the value of "name" (length 51) does not fit dbo.users.name (50)',
    );
    await expect(mssql.executeQuery('SELECT 1', { avatar: Buffer.alloc(5) }, ['users'])).rejects.toThrow(
      'does not fit dbo.users.avatar (4)',
    );
    await expect(
      mssql.executeQuery('SELECT 1', { name: 'x'.repeat(50), bio: 'x'.repeat(9000) }, ['users']),
    ).resolves.toBeDefined();
  });

  it('pads a short binary(n) value to n bytes', async () => {
    const mssql = await connected();

    await mssql.executeQuery(
      'SELECT @pin_hash, @avatar',
      { pin_hash: Buffer.from([1, 2]), avatar: Buffer.from([1, 2]) },
      ['users'],
    );

    expect(lastRequest().inputs).toEqual([
      ['pin_hash', { type: 'Binary', args: [4] }, Buffer.from([1, 2, 0, 0])],
      ['avatar', { type: 'VarBinary', args: [4] }, Buffer.from([1, 2])],
    ]);
    await mssql.executeQuery('SELECT @pin_hash', { pin_hash: null }, ['users']);
    expect(lastRequest().inputs).toEqual([['pin_hash', { type: 'Binary', args: [4] }, null]]);
  });

  it('resolves a table without schema like the server: default schema, then dbo', async () => {
    const mssql = await connected();
    const typeOfId = async (table: string) => {
      await mssql.executeQuery('SELECT 1', { id: 1 }, [table]);
      return (lastRequest().inputs[0][1] as { type: string }).type;
    };

    expect(await typeOfId('[audit].[orders]')).toBe('BigInt');
    expect(await typeOfId('DBO.Orders')).toBe('Int');
    expect(await typeOfId('orders')).toBe('Int');
    // Not in dbo: the server would not find it either
    await expect(typeOfId('trail')).rejects.toThrow('unknown table or view "trail"');
    await expect(typeOfId('nope')).rejects.toThrow('unknown table or view "nope"');
  });

  it('looks in the default schema of the connected user first', async () => {
    FakeRequest.defaultSchema = 'Audit';
    const mssql = await connected();
    FakeRequest.defaultSchema = 'dbo';

    await mssql.executeQuery('SELECT 1', { id: 1, email: 'a@b.c' }, ['orders', 'trail', 'users']);

    expect(lastRequest().inputs).toEqual([
      ['id', { type: 'BigInt', args: [] }, 1],
      ['email', { type: 'VarChar', args: [100] }, 'a@b.c'], // not in audit: found in dbo
    ]);
  });

  it('matches names as written first, and ignores case only when that is unambiguous', async () => {
    const mssql = await connected();

    await mssql.executeQuery('SELECT 1', { Name: 'x', name: 'y', NAME: 'z' }, ['Accounts']);
    expect(lastRequest().inputs).toEqual([
      ['Name', { type: 'VarChar', args: [10] }, 'x'],
      ['name', { type: 'VarChar', args: [20] }, 'y'],
      ['NAME', 'z'], // two columns differ only by case: left to the driver
    ]);

    await mssql.executeQuery('SELECT 1', { ID: 1 }, ['dbo.accounts']);
    expect(lastRequest().inputs).toEqual([['ID', { type: 'Int', args: [] }, 1]]);

    await expect(mssql.executeQuery('SELECT 1', { id: 1 }, ['ACCOUNTS'])).rejects.toThrow('unknown table or view');
  });

  it('sends text the database code page cannot carry as Unicode, and counts bytes for UTF-8 columns', async () => {
    const mssql = await connected();

    await mssql.executeQuery('SELECT 1', { utf8: 'ééééé', latin: 'é'.repeat(10), jp: '日本語日本語' }, ['texts']);
    expect(lastRequest().inputs).toEqual([
      ['utf8', { type: 'NVarChar', args: [10] }, 'ééééé'], // 10 bytes in UTF-8
      ['latin', { type: 'VarChar', args: [10] }, 'é'.repeat(10)], // the database's own code page
      ['jp', { type: 'NVarChar', args: [10] }, '日本語日本語'], // double-byte code page: length left to the server
    ]);

    // ASCII is the same in every code page: declared like the column
    await mssql.executeQuery('SELECT 1', { utf8: 'abcdefghij', jp: 'abc' }, ['texts']);
    expect(lastRequest().inputs).toEqual([
      ['utf8', { type: 'VarChar', args: [10] }, 'abcdefghij'],
      ['jp', { type: 'VarChar', args: [10] }, 'abc'],
    ]);

    await expect(mssql.executeQuery('SELECT 1', { utf8: 'éééééé' }, ['texts'])).rejects.toThrow(
      'the value of "utf8" (length 12) does not fit dbo.texts.utf8 (10)',
    );
  });

  it('uses explicit TypedValue inputs as given', async () => {
    const mssql = await connected();

    await mssql.executeQuery(
      'SELECT @code, @amount, @n',
      {
        code: { datatype: 'varchar', typeLength: 3, value: 'abc' },
        amount: { datatype: 'Decimal', typeLength: 10, scale: 2, value: 1.25 },
        n: { datatype: 'Int', value: 1 },
      },
      ['users'],
    );

    expect(lastRequest().inputs).toEqual([
      ['code', { type: 'VarChar', args: [3] }, 'abc'],
      ['amount', { type: 'Decimal', args: [10, 2] }, 1.25],
      ['n', { type: 'Int', args: [] }, 1],
    ]);
  });

  it('types stored procedure inputs and outputs from the procedure definition', async () => {
    const mssql = await connected();

    await mssql.executeSP(
      '[dbo].[usp_create_user]',
      { email: 'a@b.c', balance: 1.5, extra: 'x' },
      { id: undefined, code: undefined },
    );

    const request = lastRequest();
    expect(request.execute).toHaveBeenCalledWith('[dbo].[usp_create_user]');
    expect(request.query).not.toHaveBeenCalled();
    expect(request.inputs).toEqual([
      ['email', { type: 'VarChar', args: [100] }, 'a@b.c'],
      ['balance', { type: 'Decimal', args: [18, 4] }, 1.5],
      ['extra', 'x'], // not a parameter of the procedure: left to the driver (and to SQL Server to reject)
    ]);
    expect(request.outputs).toEqual([
      ['id', { type: 'Int', args: [] }, undefined],
      ['code', { type: 'NVarChar', args: [10] }, undefined],
    ]);
    await expect(mssql.executeSP('usp_create_user', { email: 'x'.repeat(101) })).rejects.toThrow(
      'does not fit dbo.usp_create_user.email (100)',
    );
  });

  it('runs procedures outside the schema with driver-typed inputs and explicit outputs', async () => {
    const mssql = await connected();

    await mssql.executeSP('other.dbo.usp_sync', { email: 'a@b.c' }, { total: { datatype: 'Int', value: undefined } });

    expect(lastRequest().inputs).toEqual([['email', 'a@b.c']]);
    expect(lastRequest().outputs).toEqual([['total', { type: 'Int', args: [] }, undefined]]);
    await expect(mssql.executeSP('other.dbo.usp_sync', {}, { total: undefined })).rejects.toThrow(
      'output parameter "total" has no known type',
    );
  });

  it('rejects unknown datatypes', async () => {
    const mssql = await connected();

    await expect(mssql.executeQuery('SELECT 1', { x: { datatype: 'Nope', value: 1 } })).rejects.toThrow(
      'unknown datatype',
    );
  });

  it('overrides the request timeout for one statement', async () => {
    const mssql = await connected();

    await mssql.executeQuery('SELECT @n', { n: 1 }, [], { timeoutMs: 60_000 });
    expect(lastRequest().overrides).toEqual({ requestTimeout: 60_000 });
    expect(lastRequest().inputs).toEqual([['n', 1]]);

    await mssql.executeSP('usp_create_user', { email: 'a@b.c' }, {}, { timeoutMs: 1_000 });
    expect(lastRequest().overrides).toEqual({ requestTimeout: 1_000 });
    expect(lastRequest().execute).toHaveBeenCalledWith('usp_create_user');
  });

  it('commits a transaction whose work resolves', async () => {
    const mssql = await connected();

    const result = await mssql.transaction(async (tx) => {
      await tx.executeQuery('UPDATE users SET name = @name', { name: 'Ada' }, ['users']);
      const { recordset } = await tx.executeQuery<{ id: number }>('SELECT id FROM users');
      await tx.executeSP('usp_create_user', { email: 'a@b.c' });
      return recordset[0].id;
    }, 'SERIALIZABLE');

    const transaction = FakePool.last.transactions[0];
    expect(result).toBe(1);
    expect(transaction.begin).toHaveBeenCalledWith(4);
    expect(transaction.request).toHaveBeenCalledTimes(3);
    expect(transaction.commit).toHaveBeenCalled();
    expect(transaction.rollback).not.toHaveBeenCalled();
  });

  it('rolls a transaction back when its work throws', async () => {
    const mssql = await connected();

    await expect(
      mssql.transaction(async (tx) => {
        await tx.executeQuery('UPDATE users SET name = @name', { name: 'Ada' });
        throw new Error('invalid order');
      }),
    ).rejects.toThrow('invalid order');

    const transaction = FakePool.last.transactions[0];
    expect(transaction.begin).toHaveBeenCalledWith(undefined);
    expect(transaction.rollback).toHaveBeenCalled();
    expect(transaction.commit).not.toHaveBeenCalled();
  });

  it('keeps the original error when the server already aborted the transaction', async () => {
    const mssql = await connected();

    await expect(
      mssql.transaction(async () => {
        FakePool.last.transactions[0].rollback.mockRejectedValueOnce(new Error('EABORT'));
        throw new Error('deadlock victim');
      }),
    ).rejects.toThrow('deadlock victim');
  });

  it('streams rows with typed inputs and its own timeout, without cancelling a finished query', async () => {
    const mssql = await connected();
    FakeRequest.streamed = [{ id: 1 }, { id: 2 }, { id: 3 }];

    const rows: { id: number }[] = [];
    const stream = mssql.streamQuery<{ id: number }>('SELECT id FROM users WHERE email = @email', { email: 'a@b.c' }, [
      'users',
    ]);
    for await (const row of stream) rows.push(row);

    expect(rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(lastRequest().inputs).toEqual([['email', { type: 'VarChar', args: [100] }, 'a@b.c']]);
    expect(lastRequest().query).toHaveBeenCalledWith('SELECT id FROM users WHERE email = @email');
    expect(lastRequest().cancel).not.toHaveBeenCalled();

    for await (const _row of mssql.streamQuery('SELECT 1', {}, [], { timeoutMs: 5_000 })) break;
    expect(lastRequest().overrides).toEqual({ requestTimeout: 5_000 });
  });

  it('cancels a streamed query when the consumer stops early', async () => {
    const mssql = await connected();
    FakeRequest.streamed = [{ id: 1 }, { id: 2 }, { id: 3 }];

    for await (const row of mssql.streamQuery<{ id: number }>('SELECT id FROM users')) {
      if (row.id === 2) break;
    }

    expect(lastRequest().cancel).toHaveBeenCalledOnce();
  });

  it('rethrows and logs a streamed query failing midway', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const mssql = await connected();
    FakeRequest.streamed = [{ id: 1 }, new Error('connection lost')];

    const rows: unknown[] = [];
    const consume = async () => {
      for await (const row of mssql.streamQuery('SELECT id FROM users')) rows.push(row);
    };

    await expect(consume()).rejects.toThrow('connection lost');
    expect(rows).toEqual([{ id: 1 }]);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ info: 'MSSQL statement failed', rows: 1 }));
    expect(lastRequest().cancel).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('streams on the connection of a transaction', async () => {
    const mssql = await connected();
    FakeRequest.streamed = [{ id: 1 }];

    const rows = await mssql.transaction(async (tx) => {
      const collected: unknown[] = [];
      for await (const row of tx.streamQuery('SELECT id FROM users')) collected.push(row);
      return collected;
    });

    expect(rows).toEqual([{ id: 1 }]);
    expect(FakePool.last.transactions[0].request).toHaveBeenCalledOnce();
    expect(FakePool.last.transactions[0].commit).toHaveBeenCalled();
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

  it('is not ready while its health check fails, and ready again when it passes', async () => {
    const mssql = new MssqlConnector({ ...baseConfig, healthCheckIntervalMs: 5 });
    await mssql.init();
    const pool = FakePool.last;
    expect(pool.config).not.toHaveProperty('healthCheckIntervalMs');
    expect(mssql.isReady()).toBe(true);

    FakeRequest.down = true;
    await vi.waitFor(() => expect(mssql.isReady()).toBe(false), { interval: 1 });
    expect(pool.requests.at(-1)!.overrides).toEqual({ requestTimeout: 5 });

    FakeRequest.down = false;
    await vi.waitFor(() => expect(mssql.isReady()).toBe(true), { interval: 1 });

    await mssql.close();
    const pings = pool.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(pool.requests).toHaveLength(pings);
  });

  it('says so when it is disabled', async () => {
    const mssql = new MssqlConnector({ ...baseConfig, enabled: false });

    await expect(mssql.executeQuery('SELECT 1')).rejects.toThrow('disabled');
  });

  it('releases the pool when connecting fails', async () => {
    const mssql = new MssqlConnector(baseConfig);
    const connect = vi.spyOn(FakePool.prototype, 'connectOnce').mockRejectedValueOnce(new Error('ESOCKET'));

    await expect(mssql.init()).rejects.toThrow('ESOCKET');

    expect(FakePool.last.close).toHaveBeenCalled();
    expect(mssql.isReady()).toBe(false);
    await expect(mssql.executeQuery('SELECT 1')).rejects.toThrow('not ready');
    connect.mockRestore();
  });

  it('is ready before the schema is loaded, and makes the statements that need it wait', async () => {
    let loaded!: () => void;
    const request = vi.spyOn(FakePool.prototype, 'newRequest').mockImplementationOnce(() => {
      const slow = new FakeRequest();
      const query = slow.query.getMockImplementation()!;
      slow.query.mockImplementationOnce(async (command) => {
        await new Promise<void>((resolve) => (loaded = resolve));
        return query(command);
      });
      return slow;
    });
    const mssql = await connected({ schemaLoaded: false });
    expect(mssql.isReady()).toBe(true);

    // No tables: runs without the schema
    await mssql.executeQuery('SELECT @email', { email: 'a@b.c' });
    expect(lastRequest().inputs).toEqual([['email', 'a@b.c']]);

    const waiting = mssql.executeQuery('SELECT @email', { email: 'a@b.c' }, ['users']);
    await new Promise((resolve) => setImmediate(resolve));
    expect(FakePool.last.requests).toHaveLength(2);

    loaded();
    await waiting;
    expect(lastRequest().inputs).toEqual([['email', { type: 'VarChar', args: [100] }, 'a@b.c']]);
    request.mockRestore();
  });

  it('logs a failed schema load and retries it for the next statement that needs it', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const request = vi.spyOn(FakePool.prototype, 'newRequest').mockImplementationOnce(() => {
      const failing = new FakeRequest();
      failing.query.mockRejectedValueOnce(new Error('no permission'));
      return failing;
    });
    const mssql = await connected({ schemaLoaded: false });

    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(expect.objectContaining({ info: 'MSSQL schema load failed' })),
    );
    expect(mssql.isReady()).toBe(true);

    await mssql.executeQuery('SELECT @email', { email: 'a@b.c' }, ['users']);
    expect(lastRequest().inputs).toEqual([['email', { type: 'VarChar', args: [100] }, 'a@b.c']]);
    request.mockRestore();
    error.mockRestore();
  });

  it('refreshes the schema once for concurrent calls, keeping the previous one in use meanwhile', async () => {
    const mssql = await connected();
    let loaded!: () => void;
    const request = vi.spyOn(FakePool.prototype, 'newRequest').mockImplementationOnce(() => {
      const slow = new FakeRequest();
      slow.query.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => (loaded = resolve));
        // The table changed: email is now varchar(200)
        return { recordset: [column('dbo.users', 'email', 'varchar', 200)], rowsAffected: [1] };
      });
      return slow;
    });

    const refreshes = [mssql.refreshSchema(), mssql.refreshSchema()];
    await vi.waitFor(() => expect(loaded).toBeDefined(), { interval: 1 });
    await mssql.executeQuery('SELECT @email', { email: 'a@b.c' }, ['users']);
    expect(lastRequest().inputs).toEqual([['email', { type: 'VarChar', args: [100] }, 'a@b.c']]);

    loaded();
    await Promise.all(refreshes);
    // Three queries for the initial load, one statement, three queries for the single refresh
    expect(FakePool.last.requests).toHaveLength(7);

    await mssql.executeQuery('SELECT @email', { email: 'a@b.c' }, ['users']);
    expect(lastRequest().inputs).toEqual([['email', { type: 'VarChar', args: [200] }, 'a@b.c']]);
    request.mockRestore();
  });

  it('keeps the previous schema when a refresh fails', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const mssql = await connected();
    const request = vi.spyOn(FakePool.prototype, 'newRequest').mockImplementationOnce(() => {
      const failing = new FakeRequest();
      failing.query.mockRejectedValueOnce(new Error('no permission'));
      return failing;
    });

    await expect(mssql.refreshSchema()).rejects.toThrow('no permission');

    await mssql.executeQuery('SELECT @email', { email: 'a@b.c' }, ['users']);
    expect(lastRequest().inputs).toEqual([['email', { type: 'VarChar', args: [100] }, 'a@b.c']]);
    request.mockRestore();
    error.mockRestore();
  });

  it('aborts an init that is still connecting when closed', async () => {
    const mssql = new MssqlConnector(baseConfig);
    let connected!: () => void;
    const connect = vi
      .spyOn(FakePool.prototype, 'connectOnce')
      .mockImplementationOnce(() => new Promise<void>((resolve) => (connected = resolve)));

    const initializing = mssql.init();
    await vi.waitFor(() => expect(connect).toHaveBeenCalled());
    await mssql.close();
    connected();

    await expect(initializing).rejects.toThrow('closed during init');
    expect(mssql.isReady()).toBe(false);
    connect.mockRestore();
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
