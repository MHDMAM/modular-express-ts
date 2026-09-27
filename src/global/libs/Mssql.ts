import logger from '@utils/logger';
import config from 'config';
import _ from 'lodash';
import * as sql from 'mssql';

export interface IColumnDetails {
  datatype: string;
  typeLength?: number;
  value: any;
}

export interface ITableDetails {
  ColumnName: string;
  DataType: string;
  MaxLength: number;
  TableName: string;
}

// Type guard function
function isIColumnDetails(obj: any): obj is IColumnDetails {
  return obj && typeof obj === 'object' && 'datatype' in obj && 'value' in obj;
}

function requestInput(target: sql.Request, ioSource: Record<string, IColumnDetails | any>) {
  if (!ioSource) return;

  _.each(ioSource, (val, key) => {
    if (isIColumnDetails(val)) {
      const datatype = sql[val.datatype](val.typeLength || (val.value && val.value.length) || null);
      target.input(key, datatype, val.value);
    } else {
      target.input(key, val);
    }
  });
}

function requestOutput(target: sql.Request, ioSource: Record<string, any>) {
  if (!ioSource) return;
  _.each(ioSource, (val, key) => {
    if (isIColumnDetails(val)) {
      const datatype = sql[val.datatype](val.typeLength || (val.value && val.value.length) || null);
      target.output(key, datatype, val.value);
    } else {
      target.output(key, val);
    }
  });
}

async function _executeQuery(this: Sql, query: string, inputs: Record<string, any>): Promise<any> {
  const request = this.pool.request();
  request.on('error', this.onSqlErrorHandler.bind(this));
  if (!request) return Promise.reject();
  requestInput(request, inputs);

  const start = process.hrtime.bigint();
  const result = await request.query(query).catch((error) => {
    const end = process.hrtime.bigint();
    const executeBenchmark = Number((end - start) / 1000000n);
    return Promise.reject({ ...error, executeBenchmark });
  });
  const end = process.hrtime.bigint();
  const executeBenchmark = Number((end - start) / 1000000n);
  if (!result) return;
  return Promise.resolve({ ...result, executeBenchmark });
}

async function _executeSP(this: Sql, query: string, inputs: Record<string, any>, output: Record<string, any>) {
  const request = this.pool.request();
  request.on('error', this.onSqlErrorHandler.bind(this));
  if (!request) return Promise.reject();
  requestInput(request, inputs);
  requestInput(request, output);

  const start = process.hrtime.bigint();
  const result = await request.query(query).catch((error) => {
    const end = process.hrtime.bigint();
    const executeBenchmark = Number((end - start) / 1000000n);
    return Promise.reject({ ...error, executeBenchmark });
  });
  const end = process.hrtime.bigint();
  const executeBenchmark = Number((end - start) / 1000000n);
  if (!result) return;
  return Promise.resolve({ ...result, executeBenchmark });
}

class Sql {
  pool: sql.ConnectionPool;
  schema: Record<string, ITableDetails[]>;
  dbConfig: any;
  _WaitForSql: Promise<void>;

  Types = [
    'Char',
    'NChar',
    'VarChar',
    'NVarChar',
    'Text',
    'NText',
    'Int',
    'BigInt',
    'TinyInt',
    'SmallInt',
    'Bit',
    'Float',
    'Real',
    'Money',
    'SmallMoney',
    'Numeric',
    'Decimal',
    'DateTime',
    'Time',
    'Date',
    'DateTime2',
    'DateTimeOffset',
    'SmallDateTime',
    'UniqueIdentifier',
    'Image',
    'Binary',
    'VarBinary',
    'Xml',
    'UDT',
    'TVP',
    'Variant',
  ];

  constructor() {
    sql.on('error', this.onSqlErrorHandler.bind(this));
    this.dbConfig = { ...config.get('db') };
    this.connect();
  }

  async connect() {
    this._WaitForSql = new Promise(async (resolve, reject) => {
      try {
        this.pool = await sql.connect(this.dbConfig);
        logger.info({
          msg: 'Connection pool created.',
          path: 'indexSQL/connect',
          database: {
            dbServer: this.dbConfig.server,
            dbName: this.dbConfig.database,
          },
        });
        await this.loadTableSchema();
        resolve();
      } catch (error) {
        this.onSqlErrorHandler(error);
        reject(error);
      }
    });
  }

  async loadTableSchema() {
    const query = `
      SELECT
          col.name AS ColumnName,
          types.Name AS DataType,
          col.max_length AS MaxLength,
          tbl.name AS TableName
      FROM
          sys.columns col WITH (NOLOCK)
      INNER JOIN
          sys.types types WITH (NOLOCK) ON col.user_type_id = types.user_type_id
      LEFT OUTER JOIN
          sys.tables tbl WITH (NOLOCK) ON tbl.object_id = col.object_id
      WHERE tbl.name IS NOT NULL AND tbl.name <> 'sysdiagrams'
      ORDER BY tbl.name
    `;
    const types = await _executeQuery.call(this, query, {});

    if (!types) return Promise.reject();

    this.schema = _(types.recordset)
      .map((item: any): ITableDetails => {
        const type = this.Types.find((type) => type.toLowerCase() === item.DataType.toLowerCase());
        item.DataType = type;
        return {
          ColumnName: item.ColumnName,
          DataType: type || item.DataType,
          MaxLength: item.MaxLength,
          TableName: item.TableName,
        };
      })
      .groupBy('TableName')
      .value() as Record<string, ITableDetails[]>; // Explicit cast

    return Promise.resolve();
  }

  async executeQuery(query: string, inputs: Record<string, any>, tables: string[], recordset = true): Promise<any> {
    await this._WaitForSql;
    const preparedData: Record<string, any> = {};

    tables.forEach((table) => {
      const tempPreparedData = this.buildDataObj(inputs, table);
      _.assign(preparedData, tempPreparedData);
    });

    try {
      const result = await _executeQuery.call(this, query, preparedData);
      logger.info({
        path: 'SQL Class/executeQuery',
        info: 'Success Executing Query',
        rowsAffected: result.rowsAffected,
        executeBenchmark: result.executeBenchmark,
        query,
        preparedData,
      });

      if (recordset) {
        return result.recordset ?? null;
      }
      return _.omit(result, 'executeBenchmark');
    } catch (error) {
      logger.error({
        path: 'SQL Class/executeQuery',
        msg: 'Failed Executing Query',
        error,
        error_message: error.message,
        error_stack: error.stack,
        dbQuery: {
          executeBenchmark: error.executeBenchmark,
          query,
          inputs,
        },
      });
      throw error;
    }
  }

  async executeQueryMulti(query: string, inputs: Record<string, any>, tables: string[], recordset = true) {
    await this._WaitForSql;
    const preparedData: Record<string, any> = {};

    tables.forEach((table) => {
      const tempPreparedData = this.buildDataObj(inputs, table);
      _.assign(preparedData, tempPreparedData);
    });

    try {
      const result = await _executeQuery.call(this, query, preparedData);
      logger.info({
        path: 'SQL Class/executeQuery',
        info: 'Success Executing Query',
        rowsAffected: result.rowsAffected,
        executeBenchmark: result.executeBenchmark,
        query,
        preparedData,
      });

      // if (recordset && result && result.recordset) {
      if (recordset) {
        return result.recordset ?? null;
      }
      return _.omit(result, 'executeBenchmark');
    } catch (error) {
      logger.error({
        path: 'SQL Class/executeQuery',
        msg: 'Failed Executing Query',
        error,
        error_message: error.message,
        error_stack: error.stack,
        dbQuery: {
          executeBenchmark: error.executeBenchmark,
          query,
          inputs,
        },
      });
      throw error;
    }
  }

  async executeSP(spName: string, inputs: Record<string, any>, outputs: Record<string, any>): Promise<any> {
    await this._WaitForSql;
    try {
      const result = await _executeSP.call(this, spName, inputs, outputs);
      return _.omit(result, 'executeBenchmark');
    } catch (error) {
      logger.error({
        path: 'indexSQL/executeSP',
        msg: 'Failed Executing SP',
        error_message: error.message,
        error_stack: error.stack,
        executeBenchmark: error.executeBenchmark,
        dbQuery: {
          inputs,
          outputs,
        },
      });
      throw error;
    }
  }

  buildDataObj(queryInputs: Record<string, any>, tableName: string): Record<string, any> {
    const table: ITableDetails[] = this.schema[tableName];
    const returnObj: Record<string, any> = {};

    _.each(queryInputs, (value: any, columnName: string) => {
      const col = _.find(table, { ColumnName: columnName });

      if (!col || _.isObject(value)) {
        returnObj[columnName] = value;
      } else {
        const length = _.min([(value && value.length) || 0, col.MaxLength]) as number;
        returnObj[columnName] = {
          value: value,
          datatype: col.DataType,
          typeLength: length < 0 ? value.length : length,
        };
      }
    });

    return returnObj;
  }

  onSqlErrorHandler(error: any) {
    logger.error({
      path: 'sql/index',
      msg: 'Connection Error',
      error_message: error.message,
      error_stack: error.stack,
    });

    if (error.message === 'No connection is specified for that request.') {
      try {
        this.pool.close();
      } catch (err) {
        logger.error({
          path: 'sql/index',
          msg: 'Failed to close pool',
          error_message: err.message,
          error_stack: err.stack,
        });
      }
      setTimeout(this.connect.bind(this), 5000);
    }
  }
}

const sqlInstance = new Sql();

export default sqlInstance;
