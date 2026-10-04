import { accessSync, constants, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pino from 'pino';

import config from '#config';
import { failStartup } from '#core/fail-startup';
import { DailyLogFile, logClock } from '#core/log-file';
import { getRequestContext } from '#core/request-context';

const { level, output, timeZone, retentionDays } = config.log;
// Relative paths resolve against the working directory
const dir = resolve(config.log.dir);
const clock = logClock(timeZone);
const dateOf = (ms: number) => clock(ms).date;

const taps = new Set<(line: string) => void>();

/** Calls `listener` with every line logged (one JSON object, newline included); returns a function that stops it. */
export function tapLogs(listener: (line: string) => void): () => void {
  taps.add(listener);
  return () => void taps.delete(listener);
}

const streams: pino.StreamEntry[] = [{ level, stream: { write: (line) => taps.forEach((tap) => tap(line)) } }];
if (output !== 'stdout') {
  // Checked now, so the app does not start without its log files; later failures are reported on stderr instead
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
  } catch (error) {
    failStartup(`Cannot write logs to LOG_DIR (${dir}): ${(error as Error).message}`);
  }
  // One file per day with everything, and one with the errors only
  streams.push({ level, stream: new DailyLogFile(dir, 'app', dateOf, retentionDays) });
  streams.push({ level: 'error', stream: new DailyLogFile(dir, 'error', dateOf, retentionDays) });
}
if (output !== 'file') streams.push({ level, stream: process.stdout });

/**
 * One JSON object per line: `{ level, time, requestId, traceId, message?, ...fields }`.
 * `requestId` / `traceId` come from the current request context, so every log written while handling a request is
 * correlated without passing ids around. `logger.info({ info: 'x', a: 1 })` puts `info` and `a` at the top level;
 * `logger.info('x')` writes `message`. An `Error` under `error` (or `err`) is written with its message and stack.
 */
const logger = pino(
  {
    level,
    // No pid and hostname on every line
    base: undefined,
    messageKey: 'message',
    timestamp: () => `,"time":"${clock(Date.now()).time}"`,
    formatters: { level: (label) => ({ level: label }) },
    // A copy: pino merges the logged fields into the object it is given
    mixin: () => ({ ...getRequestContext() }),
    serializers: { error: pino.stdSerializers.err, err: pino.stdSerializers.err },
  },
  pino.multistream(streams),
);

export default logger;
