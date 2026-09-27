import config from 'config';
import jsonStringify from 'fast-safe-stringify';
import { resolve } from 'path';
import winston from 'winston';
import winstonDaily from 'winston-daily-rotate-file';
// logs dir, relative paths resolve against the working directory
const logDir: string = resolve(config.get('log_dir') as string);

// Define log format
const consoleLogFormat = winston.format.printf(({ timestamp, level, message }) =>
  jsonStringify({ time: timestamp, message, level }, (key: string, value: any) => {
    if (value instanceof Error) {
      let error: any = {};

      Object.getOwnPropertyNames(value).forEach(function (key) {
        error[key] = value[key as keyof Error];
      });
      if (error.stack) {
        error.stack = error.stack.replace(/\s\s+/g, ' ').replace(/[\\]/g, '/');
      }
      return error;
    }
    if (typeof value === 'bigint') value = value.toString();
    return value;
  }),
);

const loggerFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.json(),
);

/*
 * Log Level
 * error: 0, warn: 1, info: 2, http: 3, verbose: 4, debug: 5, silly: 6
 */
const logger = winston.createLogger({
  format: loggerFormat,
  transports: [
    new winston.transports.Console({
      level: 'silly',
      format: winston.format.combine(consoleLogFormat, winston.format.splat()),
    }),
    // debug log setting
    new winstonDaily({
      datePattern: 'YYYY-MM-DD',
      dirname: logDir + '/logs',
      filename: `info-%DATE%.log`,
    }),
    // error log setting
    new winstonDaily({
      level: 'error',
      datePattern: 'YYYY-MM-DD',
      dirname: logDir + '/error',
      filename: `error-%DATE%.log`,
      handleExceptions: true,
    }),
  ],
});

export default logger;
