import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';

export interface LogTime {
  /** `YYYY-MM-DD` in the log time zone. */
  date: string;
  /** ISO 8601 with the zone's offset, e.g. `2026-10-04T08:30:00.123+08:00`. */
  time: string;
}

/** Returns a function giving the date and time of a timestamp in `timeZone` (an IANA name; the local zone if not set). */
export function logClock(timeZone?: string): (ms: number) => LogTime {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  });
  return (ms) => {
    const parts: Record<string, string> = {};
    for (const { type, value } of format.formatToParts(ms)) parts[type] = value;
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    // "GMT+08:00", or "GMT" alone for UTC
    const offset = parts.timeZoneName.replace('GMT', '') || '+00:00';
    return { date, time: `${date}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}${offset}` };
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Appends lines to `<dir>/<name>-<YYYY-MM-DD>.log`, starting a new file when the day changes in the log time zone.
 * Writes are synchronous, so nothing is lost when the process exits right after logging.
 */
export class DailyLogFile {
  private file?: ReturnType<typeof pino.destination>;
  private day = '';
  /** The minute `day` was last computed in: the date is only looked up again when the minute changes. */
  private minute = -1;
  /** A write failed and was reported; set back once a line is written. */
  private failing = false;

  constructor(
    private readonly dir: string,
    private readonly name: string,
    private readonly dateOf: (ms: number) => string,
    /** Files older than this many days are deleted when a new file is started; 0 keeps them all. */
    private readonly retentionDays = 0,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Never throws: a log file that cannot be written (folder gone, no permission, disk full) must not fail whatever was
   * being logged. The failure is reported once on stderr, and opening the file is tried again every minute.
   */
  write(line: string): void {
    const ms = this.now();
    const minute = Math.floor(ms / 60_000);
    try {
      if (minute !== this.minute) {
        this.minute = minute;
        const day = this.dateOf(ms);
        if (day !== this.day) this.open(day, ms);
      }
      if (!this.file) return;
      this.file.write(line);
      this.failing = false;
    } catch (error) {
      if (this.failing) return;
      this.failing = true;
      process.stderr.write(`Cannot write the log file in ${this.dir}: ${(error as Error).message}\n`);
    }
  }

  end(): void {
    this.file?.end();
    this.file = undefined;
    this.day = '';
    this.minute = -1;
  }

  private open(day: string, ms: number): void {
    this.file?.end();
    // Until the new file is open there is none: a failure below is tried again
    this.file = undefined;
    this.day = '';
    mkdirSync(this.dir, { recursive: true });
    this.file = pino.destination({ dest: join(this.dir, `${this.name}-${day}.log`), sync: true, append: true });
    this.day = day;
    if (this.retentionDays > 0) this.prune(this.dateOf(ms - this.retentionDays * DAY_MS));
  }

  /** Deletes this log's files dated before `oldest`. A failure is ignored: logging must not stop for it. */
  private prune(oldest: string): void {
    try {
      for (const file of readdirSync(this.dir)) {
        const day =
          file.startsWith(`${this.name}-`) && file.slice(this.name.length + 1).match(/^(\d{4}-\d{2}-\d{2})\.log$/);
        if (day && day[1] < oldest) rmSync(join(this.dir, file), { force: true });
      }
    } catch {
      // Left for the next day
    }
  }
}
