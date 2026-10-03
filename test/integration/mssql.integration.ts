import { randomUUID } from 'node:crypto';
import { MSSQLServerContainer, type StartedMSSQLServerContainer } from '@testcontainers/mssqlserver';
import sql from 'mssql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MssqlConnector, type MssqlConfig } from '#connectors/mssql/mssql';

// The connector against a real SQL Server (Docker required): `npm run test:integration`

const IMAGE = 'mcr.microsoft.com/mssql/server:2022-latest';

const DDL = [
  `CREATE SCHEMA audit`,
  `CREATE TYPE dbo.email_address FROM varchar(120)`,
  `CREATE TYPE dbo.id_list AS TABLE (id int NOT NULL PRIMARY KEY)`,
  `CREATE TABLE dbo.everything (
     id int IDENTITY PRIMARY KEY,
     c_varchar varchar(20), c_nvarchar nvarchar(20), c_varchar_max varchar(max), c_nvarchar_max nvarchar(max),
     c_char char(5), c_nchar nchar(5), c_text text, c_ntext ntext,
     c_decimal decimal(18, 4), c_numeric numeric(10, 2), c_money money, c_smallmoney smallmoney,
     c_int int, c_bigint bigint, c_smallint smallint, c_tinyint tinyint, c_bit bit, c_float float, c_real real,
     c_date date, c_time time(3), c_datetime datetime, c_smalldatetime smalldatetime,
     c_datetime2 datetime2(7), c_datetime2_3 datetime2(3), c_datetimeoffset datetimeoffset(2),
     c_uniqueidentifier uniqueidentifier, c_binary binary(4), c_varbinary varbinary(8),
     c_varbinary_max varbinary(max), c_image image, c_xml xml,
     c_sysname sysname NULL, c_email dbo.email_address, c_rowversion rowversion,
     c_geography geography, c_hierarchyid hierarchyid, c_variant sql_variant
   )`,
  // varchar columns in other code pages than the database's (1252)
  `CREATE TABLE dbo.texts (
     id int IDENTITY PRIMARY KEY,
     c_utf8 varchar(10) COLLATE Latin1_General_100_CI_AS_SC_UTF8,
     c_latin varchar(10),
     c_jp varchar(10) COLLATE Japanese_CI_AS,
     c_text_utf8 varchar(max) COLLATE Latin1_General_100_CI_AS_SC_UTF8
   )`,
  `CREATE TABLE dbo.orders (id int PRIMARY KEY, total decimal(10, 2) NOT NULL, note varchar(10))`,
  `CREATE TABLE audit.orders (id bigint PRIMARY KEY, note nvarchar(50))`,
  `CREATE TABLE audit.trail (id bigint PRIMARY KEY, entry nvarchar(50))`,
  // A user whose names without schema resolve in audit first
  `CREATE LOGIN auditor WITH PASSWORD = 'Aud1tor!Passw0rd'`,
  `CREATE USER auditor FOR LOGIN auditor WITH DEFAULT_SCHEMA = audit`,
  `GRANT SELECT, INSERT, EXECUTE TO auditor`,
  `CREATE VIEW dbo.order_totals AS SELECT id AS order_id, total AS order_total FROM dbo.orders`,
  `CREATE PROCEDURE dbo.usp_add_order
     @id int, @total decimal(10, 2), @note varchar(10) = NULL, @count int OUTPUT, @label nvarchar(30) OUTPUT
   AS
     INSERT INTO dbo.orders (id, total, note) VALUES (@id, @total, @note);
     SELECT @count = COUNT(*) FROM dbo.orders;
     SET @label = CONCAT(N'order ', @id, N' · ', @total);
     SELECT id, total FROM dbo.orders WHERE id = @id;`,
  `CREATE PROCEDURE audit.usp_log @id bigint, @note nvarchar(50), @logged_at datetime2(3) OUTPUT AS
     INSERT INTO audit.orders (id, note) VALUES (@id, @note);
     SET @logged_at = '2024-02-29T12:34:56.789';`,
  `CREATE PROCEDURE dbo.usp_sum_ids @ids dbo.id_list READONLY, @sum int OUTPUT AS SELECT @sum = SUM(id) FROM @ids`,
  `CREATE PROCEDURE dbo.usp_ping AS SELECT 1 AS pong`,
];

/** `count` rows numbered from 1. */
const NUMBERS = `SELECT TOP (@count) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n
                 FROM sys.all_columns a CROSS JOIN sys.all_columns b`;

let container: StartedMSSQLServerContainer;
let config: MssqlConfig;
let mssql: MssqlConnector;

beforeAll(async () => {
  container = await new MSSQLServerContainer(IMAGE).acceptLicense().start();
  const server = {
    server: container.getHost(),
    port: container.getPort(),
    user: container.getUsername(),
    password: container.getPassword(),
    options: { encrypt: true, trustServerCertificate: true },
  };

  const admin = await new sql.ConnectionPool({ ...server, database: 'master' }).connect();
  await admin.request().batch('CREATE DATABASE app');
  await admin.close();
  const setup = await new sql.ConnectionPool({ ...server, database: 'app' }).connect();
  for (const statement of DDL) await setup.request().batch(statement);
  await setup.close();

  config = { enabled: true, ...server, database: 'app', requestTimeout: 15_000, connectionTimeout: 5_000 };
  mssql = new MssqlConnector(config);
  await mssql.init();
});

afterAll(async () => {
  await mssql?.close();
  await container?.stop();
});

/** How SQL Server sees the parameter `name`, typed from `tables`. */
async function declared(name: string, value: unknown, tables = ['everything']) {
  const property = (p: string) => `SQL_VARIANT_PROPERTY(@${name}, '${p}')`;
  const { recordset } = await mssql.executeQuery<{ type: string; bytes: number; precision: number; scale: number }>(
    `SELECT CAST(${property('BaseType')} AS varchar(30)) AS type, CAST(${property('MaxLength')} AS int) AS bytes,
            CAST(${property('Precision')} AS int) AS precision, CAST(${property('Scale')} AS int) AS scale`,
    { [name]: value },
    tables,
  );
  return recordset[0];
}

describe('schema', () => {
  it('is ready once connected', () => {
    expect(mssql.isReady()).toBe(true);
  });

  it.each([
    ['c_varchar', 'x', { type: 'varchar', bytes: 20 }],
    ['c_nvarchar', 'x', { type: 'nvarchar', bytes: 40 }],
    ['c_char', 'x', { type: 'char', bytes: 5 }],
    ['c_nchar', 'x', { type: 'nchar', bytes: 10 }],
    ['c_decimal', 1.5, { type: 'decimal', precision: 18, scale: 4 }],
    ['c_numeric', 1.5, { type: 'numeric', precision: 10, scale: 2 }],
    ['c_money', 1.5, { type: 'money' }],
    ['c_smallmoney', 1.5, { type: 'smallmoney' }],
    ['c_int', 1, { type: 'int' }],
    ['c_bigint', 1, { type: 'bigint' }],
    ['c_smallint', 1, { type: 'smallint' }],
    ['c_tinyint', 1, { type: 'tinyint' }],
    ['c_bit', true, { type: 'bit' }],
    ['c_float', 1.5, { type: 'float' }],
    ['c_real', 1.5, { type: 'real' }],
    ['c_date', new Date(), { type: 'date' }],
    ['c_time', new Date(), { type: 'time', scale: 3 }],
    ['c_datetime', new Date(), { type: 'datetime' }],
    ['c_smalldatetime', new Date(), { type: 'smalldatetime' }],
    ['c_datetime2', new Date(), { type: 'datetime2', scale: 7 }],
    ['c_datetime2_3', new Date(), { type: 'datetime2', scale: 3 }],
    ['c_datetimeoffset', new Date(), { type: 'datetimeoffset', scale: 2 }],
    ['c_uniqueidentifier', randomUUID(), { type: 'uniqueidentifier' }],
    ['c_binary', Buffer.from([1]), { type: 'binary', bytes: 4 }],
    ['c_varbinary', Buffer.from([1]), { type: 'varbinary', bytes: 8 }],
    // sysname and alias types resolve to their base type
    ['c_sysname', 'x', { type: 'nvarchar', bytes: 256 }],
    ['c_email', 'x', { type: 'varchar', bytes: 120 }],
  ])('declares @%s like its column', async (name, value, expected) => {
    expect(await declared(name, value)).toMatchObject(expected);
  });

  it('declares a null like its column too', async () => {
    expect(await declared('c_decimal', 1.5)).toMatchObject({ type: 'decimal', precision: 18, scale: 4 });
    const { recordset } = await mssql.executeQuery<{ d: string | null }>(
      'SELECT CAST(@c_decimal AS varchar(30)) AS d',
      { c_decimal: null },
      ['everything'],
    );
    expect(recordset[0].d).toBeNull();
  });

  it('resolves tables by schema, views included', async () => {
    expect(await declared('id', 1, ['dbo.orders'])).toMatchObject({ type: 'int' });
    expect(await declared('id', 1, ['[audit].[orders]'])).toMatchObject({ type: 'bigint' });
    expect(await declared('order_total', 1.5, ['order_totals'])).toMatchObject({
      type: 'decimal',
      precision: 10,
      scale: 2,
    });
    await expect(declared('id', 1, ['nope'])).rejects.toThrow('unknown table or view "nope"');
  });

  it('resolves a name without schema like the server: default schema, then dbo', async () => {
    const insertTrail = 'INSERT INTO trail (id, entry) VALUES (@id, @entry)';
    // dbo is the default schema here: dbo.orders, and audit.trail is not found by the server either
    expect(await declared('id', 1, ['orders'])).toMatchObject({ type: 'int' });
    await expect(mssql.executeQuery(insertTrail, { id: 1, entry: 'x' }, ['trail'])).rejects.toThrow(
      'unknown table or view "trail"',
    );
    await expect(mssql.executeQuery(insertTrail, { id: 1, entry: 'x' })).rejects.toThrow(/Invalid object name 'trail'/);
    await expect(mssql.executeSP('usp_log', { id: 1, note: 'x' }, { logged_at: undefined })).rejects.toThrow(
      'output parameter "logged_at" has no known type',
    );

    const auditor = new MssqlConnector({ ...config, user: 'auditor', password: 'Aud1tor!Passw0rd' });
    await auditor.init();
    try {
      const idType = async (table: string) => {
        const { recordset } = await auditor.executeQuery<{ type: string }>(
          `SELECT CAST(SQL_VARIANT_PROPERTY(@id, 'BaseType') AS varchar(30)) AS type`,
          { id: 1 },
          [table],
        );
        return recordset[0].type;
      };
      expect(await idType('orders')).toBe('bigint'); // audit.orders
      expect(await idType('everything')).toBe('int'); // not in audit: dbo.everything
      await auditor.executeQuery(insertTrail, { id: 1, entry: 'créé' }, ['trail']);
      const logged = await auditor.executeSP('usp_log', { id: 50, note: 'x' }, { logged_at: undefined });
      expect(logged.output).toEqual({ logged_at: new Date('2024-02-29T12:34:56.789Z') });
      await mssql.executeQuery('DELETE FROM audit.orders WHERE id = 50');
    } finally {
      await auditor.close();
    }
  });

  it('rejects a value longer than its column before sending it', async () => {
    await expect(declared('c_varchar', 'x'.repeat(21))).rejects.toThrow('does not fit dbo.everything.c_varchar (20)');
    await expect(declared('c_nvarchar', 'é'.repeat(21))).rejects.toThrow('does not fit');
    await expect(declared('c_varbinary', Buffer.alloc(9))).rejects.toThrow('does not fit');
    expect(await declared('c_varchar', 'x'.repeat(20))).toMatchObject({ bytes: 20 });
  });

  it('picks up DDL changes on refresh', async () => {
    const setNote = () =>
      mssql.executeQuery('UPDATE dbo.orders SET note = @note WHERE id = -1', { note }, ['dbo.orders']);
    const note = 'x'.repeat(15);
    await expect(setNote()).rejects.toThrow('does not fit dbo.orders.note (10)');

    await mssql.executeQuery('ALTER TABLE dbo.orders ALTER COLUMN note varchar(30)');
    await expect(setNote()).rejects.toThrow('does not fit dbo.orders.note (10)');

    await mssql.refreshSchema();
    await expect(setNote()).resolves.toBeDefined();
  });
});

describe('values', () => {
  const moment = new Date('2024-02-29T12:34:56.789Z');
  const values = {
    c_varchar: 'plain ascii',
    c_nvarchar: 'héllo 日本語 😀',
    c_varchar_max: 'x'.repeat(10_000),
    c_nvarchar_max: 'é日'.repeat(5_000),
    c_char: 'ab',
    c_nchar: 'é',
    c_text: 'text',
    c_ntext: 'ntext é',
    c_decimal: 1234.5678,
    c_numeric: 99999999.99,
    c_money: 1234.5678,
    c_smallmoney: 12.34,
    c_int: -2147483648,
    c_bigint: 9007199254740991,
    c_smallint: -32768,
    c_tinyint: 255,
    c_bit: true,
    c_float: 1.5e300,
    c_real: 1.5,
    c_date: new Date('2024-02-29T00:00:00.000Z'),
    c_time: new Date('1970-01-01T12:34:56.789Z'),
    c_datetime: new Date('2024-02-29T12:34:56.123Z'),
    c_smalldatetime: new Date('2024-02-29T12:34:00.000Z'),
    c_datetime2: moment,
    c_datetime2_3: moment,
    c_datetimeoffset: new Date('2024-02-29T12:34:56.780Z'), // datetimeoffset(2): two fractional digits
    c_uniqueidentifier: 'A1B2C3D4-E5F6-4711-8899-AABBCCDDEEFF',
    c_binary: Buffer.from([1, 2, 3, 4]),
    c_varbinary: Buffer.from([1, 2, 3]),
    c_varbinary_max: Buffer.alloc(10_000, 7),
    c_image: Buffer.from([9, 8, 7]),
    c_xml: '<a>1</a>',
    c_sysname: 'a_name',
    c_email: 'ada@example.com',
  };
  const names = Object.keys(values);
  const insert = `INSERT INTO dbo.everything (${names.join(', ')}) OUTPUT INSERTED.id
                  VALUES (${names.map((name) => `@${name}`).join(', ')})`;

  it('round-trips every type through parameters typed from the schema', async () => {
    const inserted = await mssql.executeQuery<{ id: number }>(insert, values, ['everything']);
    const { id } = inserted.recordset[0];

    const { recordset } = await mssql.executeQuery<Record<string, unknown>>(
      `SELECT *, CONVERT(varchar(40), c_decimal) AS decimal_text, CONVERT(varchar(40), c_numeric) AS numeric_text,
              CONVERT(varchar(40), c_datetime2, 126) AS datetime2_text,
              CONVERT(varchar(40), c_datetime2_3, 126) AS datetime2_3_text,
              CONVERT(varchar(40), c_time) AS time_text
       FROM dbo.everything WHERE id = @id`,
      { id },
      ['everything'],
    );
    const row = recordset[0];

    expect(row).toMatchObject({
      ...values,
      c_char: 'ab   ', // fixed length: padded by the column
      c_nchar: 'é    ',
      c_bigint: '9007199254740991', // the driver returns bigint as a string
      // Stored exactly, as the server prints them
      decimal_text: '1234.5678',
      numeric_text: '99999999.99',
      datetime2_text: '2024-02-29T12:34:56.7890000',
      datetime2_3_text: '2024-02-29T12:34:56.789',
      time_text: '12:34:56.789',
    });
    expect(row.c_rowversion).toBeInstanceOf(Buffer);
  });

  it('round-trips nulls for every type', async () => {
    const nulls = Object.fromEntries(names.map((name) => [name, null]));
    const inserted = await mssql.executeQuery<{ id: number }>(insert, nulls, ['everything']);

    const { recordset } = await mssql.executeQuery<Record<string, unknown>>(
      `SELECT ${names.join(', ')} FROM dbo.everything WHERE id = @id`,
      { id: inserted.recordset[0].id },
      ['everything'],
    );

    expect(recordset[0]).toEqual(nulls);
  });

  it('leaves columns it cannot type to the driver', async () => {
    const inserted = await mssql.executeQuery<{ id: number; c_rowversion: Buffer }>(
      `INSERT INTO dbo.everything (c_geography, c_hierarchyid, c_variant)
       OUTPUT INSERTED.id, INSERTED.c_rowversion
       VALUES (geography::STGeomFromText(@c_geography, 4326), hierarchyid::Parse(@c_hierarchyid), @c_variant)`,
      { c_geography: 'POINT (3 51)', c_hierarchyid: '/1/2/', c_variant: 42 },
      ['everything'],
    );
    const { id, c_rowversion } = inserted.recordset[0];

    const { recordset } = await mssql.executeQuery<Record<string, unknown>>(
      `SELECT id, c_geography.STAsText() AS wkt, c_hierarchyid.ToString() AS node, c_variant
       FROM dbo.everything WHERE c_rowversion = @c_rowversion`,
      { c_rowversion },
      ['everything'],
    );

    expect(recordset).toEqual([{ id, wkt: 'POINT (3 51)', node: '/1/2/', c_variant: 42 }]);
  });

  it('accepts a binary(n) value shorter than n, padded like the server stores it', async () => {
    const inserted = await mssql.executeQuery<{ id: number; c_binary: Buffer }>(
      'INSERT INTO dbo.everything (c_binary) OUTPUT INSERTED.id, INSERTED.c_binary VALUES (@c_binary)',
      { c_binary: Buffer.from([1, 2]) },
      ['everything'],
    );
    const found = await mssql.executeQuery<{ id: number }>(
      'SELECT id FROM dbo.everything WHERE c_binary = @c_binary',
      { c_binary: Buffer.from([1, 2]) },
      ['everything'],
    );

    expect(inserted.recordset[0].c_binary).toEqual(Buffer.from([1, 2, 0, 0]));
    expect(found.recordset).toEqual([{ id: inserted.recordset[0].id }]);
  });

  it('uses explicit types as given', async () => {
    const { recordset } = await mssql.executeQuery<Record<string, unknown>>(
      `SELECT CAST(SQL_VARIANT_PROPERTY(@amount, 'Precision') AS int) AS precision,
              CAST(SQL_VARIANT_PROPERTY(@amount, 'Scale') AS int) AS scale,
              CAST(SQL_VARIANT_PROPERTY(@code, 'MaxLength') AS int) AS bytes, @amount AS amount`,
      {
        amount: { datatype: 'Decimal', typeLength: 12, scale: 3, value: 1.2345 },
        code: { datatype: 'char', typeLength: 3, value: 'ab' },
      },
    );

    expect(recordset[0]).toEqual({ precision: 12, scale: 3, bytes: 3, amount: 1.235 });
  });
});

describe('plan cache', () => {
  /** Plans cached for the statements containing `marker`, with their parameter declarations. */
  async function plans(marker: string) {
    const { recordset } = await mssql.executeQuery<{ text: string; executions: number }>(
      `SELECT text.text, CAST(stats.execution_count AS int) AS executions
       FROM sys.dm_exec_query_stats stats CROSS APPLY sys.dm_exec_sql_text(stats.sql_handle) text
       WHERE text.text LIKE @pattern AND text.text NOT LIKE '%dm_exec_query_stats%'`,
      { pattern: `%${marker}%` },
    );
    return recordset;
  }

  it('reuses one plan for a query whatever the length of its values', async () => {
    const marker = `plan-${randomUUID()}`;
    const query = `SELECT id FROM dbo.everything WHERE c_varchar = @c_varchar AND c_nvarchar = @c_nvarchar /* ${marker} */`;

    for (const length of [1, 5, 12, 20]) {
      await mssql.executeQuery(query, { c_varchar: 'x'.repeat(length), c_nvarchar: 'é'.repeat(length) }, [
        'everything',
      ]);
    }

    const cached = await plans(marker);
    expect(cached).toHaveLength(1);
    expect(cached[0].executions).toBe(4);
    expect(cached[0].text).toMatch(/^\(@c_varchar varchar\(20\), @c_nvarchar nvarchar\(20\)\)SELECT id/);
  });
});

describe('stored procedures', () => {
  it('types inputs and outputs from the procedure definition', async () => {
    const result = await mssql.executeSP<{ id: number; total: number }>(
      'usp_add_order',
      { id: 1, total: 10.25, note: 'first' },
      { count: undefined, label: undefined },
    );

    expect(result.recordset).toEqual([{ id: 1, total: 10.25 }]);
    expect(result.output).toEqual({ count: 1, label: 'order 1 · 10.25' });
    expect(result.returnValue).toBe(0);
    await expect(mssql.executeSP('usp_add_order', { id: 2, total: 1, note: 'x'.repeat(11) })).rejects.toThrow(
      'does not fit dbo.usp_add_order.note (10)',
    );
  });

  it('runs procedures of another schema', async () => {
    const first = await mssql.executeSP('[audit].[usp_log]', { id: 1, note: 'créé' }, { logged_at: undefined });
    const second = await mssql.executeSP('audit.usp_log', { id: 2, note: null }, { logged_at: undefined });

    expect(first.output).toEqual({ logged_at: new Date('2024-02-29T12:34:56.789Z') });
    expect(second.output).toEqual(first.output);
    const { recordset } = await mssql.executeQuery('SELECT id, note FROM audit.orders ORDER BY id');
    expect(recordset).toEqual([
      { id: '1', note: 'créé' },
      { id: '2', note: null },
    ]);
  });

  it('runs procedures without parameters and with a table-valued one', async () => {
    expect((await mssql.executeSP('usp_ping')).recordset).toEqual([{ pong: 1 }]);

    const ids = new sql.Table('dbo.id_list');
    ids.columns.add('id', sql.Int, { nullable: false });
    for (const id of [1, 2, 3]) ids.rows.add(id);
    const result = await mssql.executeSP('usp_sum_ids', { ids }, { sum: undefined });

    expect(result.output).toEqual({ sum: 6 });
  });
});

describe('transactions', () => {
  const orders = async () =>
    (await mssql.executeQuery<{ id: number }>('SELECT id FROM dbo.orders ORDER BY id')).recordset;

  it('commits when the work resolves', async () => {
    const before = await orders();

    const level = await mssql.transaction(async (tx) => {
      await tx.executeQuery('INSERT INTO dbo.orders (id, total) VALUES (@id, @total)', { id: 100, total: 1.5 }, [
        'dbo.orders',
      ]);
      await tx.executeSP('usp_add_order', { id: 101, total: 2 }, { count: undefined, label: undefined });
      const session = await tx.executeQuery<{ level: number }>(
        'SELECT transaction_isolation_level AS level FROM sys.dm_exec_sessions WHERE session_id = @@SPID',
      );
      return session.recordset[0].level;
    }, 'SERIALIZABLE');

    expect(level).toBe(4);
    expect(await orders()).toEqual([...before, { id: 100 }, { id: 101 }]);
  });

  it('rolls back when the work throws', async () => {
    const before = await orders();

    await expect(
      mssql.transaction(async (tx) => {
        await tx.executeQuery('INSERT INTO dbo.orders (id, total) VALUES (200, 1)');
        throw new Error('invalid order');
      }),
    ).rejects.toThrow('invalid order');

    expect(await orders()).toEqual(before);
  });

  it('rethrows the statement error when the server aborted the transaction', async () => {
    const before = await orders();

    await expect(
      mssql.transaction(async (tx) => {
        await tx.executeQuery('INSERT INTO dbo.orders (id, total) VALUES (300, 1)');
        await tx.executeQuery('SET XACT_ABORT ON; INSERT INTO dbo.orders (id, total) VALUES (300, 1)');
      }),
    ).rejects.toThrow(/PRIMARY KEY/);

    expect(await orders()).toEqual(before);
  });
});

describe('timeouts and streaming', () => {
  it('times out one statement without affecting the next', async () => {
    const start = Date.now();

    await expect(mssql.executeQuery(`WAITFOR DELAY '00:00:05'`, {}, [], { timeoutMs: 300 })).rejects.toMatchObject({
      code: 'ETIMEOUT',
    });

    expect(Date.now() - start).toBeLessThan(3_000);
    expect((await mssql.executeQuery('SELECT 1 AS one')).recordset).toEqual([{ one: 1 }]);
  });

  it('streams a large result row by row', async () => {
    let count = 0;
    let sum = 0;
    for await (const row of mssql.streamQuery<{ n: string }>(NUMBERS, { count: 50_000 })) {
      count++;
      sum += Number(row.n);
    }

    expect(count).toBe(50_000);
    expect(sum).toBe((50_000 * 50_001) / 2);
  });

  it('cancels the query and frees the connection when the consumer stops early', async () => {
    const single = new MssqlConnector({ ...config, pool: { min: 0, max: 1 } });
    await single.init();
    try {
      const start = Date.now();
      let count = 0;
      for await (const _row of single.streamQuery(NUMBERS, { count: 5_000_000 })) {
        if (++count === 10) break;
      }

      // The only connection of the pool: the next statement needs the cancelled one to be released
      expect((await single.executeQuery('SELECT 1 AS one')).recordset).toEqual([{ one: 1 }]);
      expect(Date.now() - start).toBeLessThan(5_000);
    } finally {
      await single.close();
    }
  });

  it('rethrows an error raised after some rows', async () => {
    const rows: unknown[] = [];
    const consume = async () => {
      const query = `${NUMBERS}; RAISERROR('half way', 16, 1);`;
      for await (const row of mssql.streamQuery(query, { count: 100 })) rows.push(row);
    };

    await expect(consume()).rejects.toThrow('half way');
    expect(rows).toHaveLength(100);
    expect((await mssql.executeQuery('SELECT 1 AS one')).recordset).toEqual([{ one: 1 }]);
  });

  it('streams inside a transaction', async () => {
    const ids = await mssql.transaction(async (tx) => {
      await tx.executeQuery('INSERT INTO dbo.orders (id, total) VALUES (400, 1), (401, 2)');
      const seen: number[] = [];
      for await (const row of tx.streamQuery<{ id: number }>('SELECT id FROM dbo.orders WHERE id >= 400 ORDER BY id')) {
        seen.push(row.id);
      }
      await tx.executeQuery('DELETE FROM dbo.orders WHERE id >= 400');
      return seen;
    });

    expect(ids).toEqual([400, 401]);
  });
});

describe('code pages', () => {
  const roundTrip = async (connector: MssqlConnector, column: string, value: string) => {
    const { recordset } = await connector.executeQuery<{ stored: string }>(
      `INSERT INTO dbo.texts (${column}) OUTPUT inserted.${column} AS stored VALUES (@${column})`,
      { [column]: value },
      ['texts'],
    );
    return recordset[0].stored;
  };

  it.each([
    ['c_utf8', 'ééééé'], // 10 bytes
    ['c_utf8', '日本語'], // 9 bytes, not in the database's code page
    ['c_utf8', 'abcdefghij'],
    ['c_latin', 'é'.repeat(10)],
    ['c_jp', '日本語日本'], // 10 bytes in code page 932
    ['c_jp', 'ｱｲｳｴｵｶｷｸｹｺ'], // one byte each in code page 932
    ['c_text_utf8', '日本語 · ' + 'é'.repeat(5000)],
  ])('keeps %s = %s', async (column, value) => {
    expect(await roundTrip(mssql, column, value)).toBe(value);
  });

  it('finds a row by non-ASCII text in a column of another code page', async () => {
    await roundTrip(mssql, 'c_utf8', '東京');
    const { recordset } = await mssql.executeQuery<{ n: number }>(
      'SELECT COUNT(*) AS n FROM dbo.texts WHERE c_utf8 = @c_utf8',
      { c_utf8: '東京' },
      ['texts'],
    );
    expect(recordset[0].n).toBe(1);
  });

  it('rejects text longer than a UTF-8 column in bytes', async () => {
    await expect(roundTrip(mssql, 'c_utf8', 'éééééé')).rejects.toThrow(
      '(length 12) does not fit dbo.texts.c_utf8 (10)',
    );
    await expect(roundTrip(mssql, 'c_utf8', '日本語日')).rejects.toThrow('(length 12) does not fit');
  });

  describe('in a UTF-8 database', () => {
    let utf8: MssqlConnector;

    beforeAll(async () => {
      const { database: _database, enabled: _enabled, ...server } = config;
      const admin = await new sql.ConnectionPool({ ...server, database: 'master' }).connect();
      await admin.request().batch('CREATE DATABASE utf8 COLLATE Latin1_General_100_CI_AS_SC_UTF8');
      await admin.close();
      const setup = await new sql.ConnectionPool({ ...server, database: 'utf8' }).connect();
      await setup.request().batch('CREATE TABLE dbo.texts (id int IDENTITY PRIMARY KEY, c_utf8 varchar(10))');
      await setup.request().batch(`CREATE PROCEDURE dbo.usp_echo @text varchar(10), @echo varchar(10) OUTPUT AS
                                     SET @echo = @text`);
      await setup.close();
      utf8 = new MssqlConnector({ ...config, database: 'utf8' });
      await utf8.init();
    });

    afterAll(() => utf8?.close());

    it('keeps non-ASCII text in varchar columns and procedure parameters', async () => {
      expect(await roundTrip(utf8, 'c_utf8', '日本語')).toBe('日本語');
      expect(await roundTrip(utf8, 'c_utf8', 'ééééé')).toBe('ééééé');
      const { output } = await utf8.executeSP('usp_echo', { text: '日本語' }, { echo: undefined });
      expect(output.echo).toBe('日本語');
    });

    it('rejects text longer than the column or the parameter in bytes', async () => {
      await expect(roundTrip(utf8, 'c_utf8', '日本語日')).rejects.toThrow('(length 12) does not fit');
      await expect(utf8.executeSP('usp_echo', { text: 'éééééé' }, { echo: undefined })).rejects.toThrow(
        '(length 12) does not fit dbo.usp_echo.text (10)',
      );
    });
  });
});

describe('case-sensitive database', () => {
  let strict: MssqlConnector;

  beforeAll(async () => {
    const { database: _database, enabled: _enabled, ...server } = config;
    const admin = await new sql.ConnectionPool({ ...server, database: 'master' }).connect();
    await admin.request().batch('CREATE DATABASE strict COLLATE Latin1_General_100_CS_AS');
    await admin.close();
    const setup = await new sql.ConnectionPool({ ...server, database: 'strict' }).connect();
    await setup.request().batch('CREATE TABLE dbo.Accounts (Name varchar(10), name nvarchar(20))');
    await setup.request().batch('CREATE TABLE dbo.accounts (id bigint)');
    await setup.close();
    strict = new MssqlConnector({ ...config, database: 'strict' });
    await strict.init();
  });

  afterAll(() => strict?.close());

  it('keeps tables and columns that differ only by case apart', async () => {
    const types = async (inputs: Record<string, unknown>, table: string) => {
      const select = Object.keys(inputs).map((name, index) => {
        return `CAST(SQL_VARIANT_PROPERTY(@${name}, 'BaseType') AS varchar(30)) AS t${index}`;
      });
      const { recordset } = await strict.executeQuery<Record<string, string>>(`SELECT ${select}`, inputs, [table]);
      return Object.values(recordset[0]);
    };

    expect(await types({ Name: 'x' }, 'Accounts')).toEqual(['varchar']);
    expect(await types({ name: 'x' }, 'Accounts')).toEqual(['nvarchar']);
    expect(await types({ id: 1 }, 'accounts')).toEqual(['bigint']);
    await expect(strict.executeQuery('SELECT 1', { id: 1 }, ['ACCOUNTS'])).rejects.toThrow('unknown table or view');
  });
});

describe('lifecycle', () => {
  it('fails init against a server that is not there, and stays unusable', async () => {
    const unreachable = new MssqlConnector({ ...config, port: 1, connectionTimeout: 2_000 });

    await expect(unreachable.init()).rejects.toThrow();

    expect(unreachable.isReady()).toBe(false);
    await expect(unreachable.executeQuery('SELECT 1')).rejects.toThrow('not ready');
  });

  it('fails init with wrong credentials', async () => {
    const denied = new MssqlConnector({ ...config, password: 'wrong' });

    await expect(denied.init()).rejects.toMatchObject({ code: 'ELOGIN' });
    expect(denied.isReady()).toBe(false);
  });

  it('closes, and can be initialised again', async () => {
    const connector = new MssqlConnector(config);
    await connector.init();
    await connector.close();

    expect(connector.isReady()).toBe(false);
    await expect(connector.executeQuery('SELECT 1')).rejects.toThrow('not ready');

    await connector.init();
    expect((await connector.executeQuery('SELECT 1 AS one', {}, ['dbo.orders'])).recordset).toEqual([{ one: 1 }]);
    await connector.close();
  });
});
