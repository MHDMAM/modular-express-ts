import { resolve } from 'path';
import safeStringify from 'fast-safe-stringify';
import winston from 'winston';
import winstonDaily from 'winston-daily-rotate-file';

import config from '#config';
import { getRequestContext } from '#core/request-context';

// logs dir, relative paths resolve against the working directory
const logDir: string = resolve(config.logDir);

// CommonJS package whose typings declare an ES default export; `.default` is the function in both
const jsonStringify = safeStringify.default;

/** Serializes errors with their message and stack (JSON.stringify would write `{}`), and bigints as strings. */
function replacer(_key: string, value: unknown) {
  if (value instanceof Error) {
    const error: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(value)) error[key] = (value as any)[key];
    if (typeof error.stack === 'string') error.stack = error.stack.replace(/\s\s+/g, ' ').replace(/[\\]/g, '/');
    return error;
  }
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * One JSON object per line: `{ time, level, requestId, traceId, message?, ...fields }`.
 * `requestId` / `traceId` come from the current request context, so every log written while handling a request is
 * correlated without passing ids around. `logger.info({ info: 'x', a: 1 })` puts `info` and `a` at the top level.
 */
const lineFormat = winston.format.printf((info) => {
  const { level, message, timestamp, ...rest } = info;
  const fields = message !== null && typeof message === 'object' ? message : { message };
  return jsonStringify({ time: timestamp, level, ...getRequestContext(), ...rest, ...fields }, replacer);
});

const format = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.splat(),
  lineFormat,
);

/*
 * Log Level
 * error: 0, warn: 1, info: 2, http: 3, verbose: 4, debug: 5, silly: 6
 */
const logger = winston.createLogger({
  format,
  transports: [
    new winston.transports.Console({ level: 'silly' }),
    new winstonDaily({
      datePattern: 'YYYY-MM-DD',
      dirname: logDir + '/logs',
      filename: `info-%DATE%.log`,
    }),
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
