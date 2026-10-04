import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DailyLogFile, logClock } from './log-file.js';

describe('logClock', () => {
  // 2026-10-04 20:30:00.123 UTC
  const moment = Date.UTC(2026, 9, 4, 20, 30, 0, 123);

  it('gives the date and time in the given time zone, with its offset', () => {
    expect(logClock('Asia/Kuala_Lumpur')(moment)).toEqual({
      date: '2026-10-05',
      time: '2026-10-05T04:30:00.123+08:00',
    });
    expect(logClock('America/New_York')(moment)).toEqual({ date: '2026-10-04', time: '2026-10-04T16:30:00.123-04:00' });
    expect(logClock('Asia/Kolkata')(moment).time).toBe('2026-10-05T02:00:00.123+05:30');
    expect(logClock('UTC')(moment)).toEqual({ date: '2026-10-04', time: '2026-10-04T20:30:00.123+00:00' });
  });

  it('follows daylight saving time', () => {
    expect(logClock('America/New_York')(Date.UTC(2026, 0, 15, 12)).time).toBe('2026-01-15T07:00:00.000-05:00');
  });

  it('uses the local time zone when none is given', () => {
    const { time } = logClock()(moment);

    // Same instant, whatever the zone of the machine
    expect(new Date(time).getTime()).toBe(moment);
    expect(time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.123[+-]\d{2}:\d{2}$/);
  });

  it('midnight is written as hour 00', () => {
    expect(logClock('UTC')(Date.UTC(2026, 9, 4, 0, 0, 0)).time).toBe('2026-10-04T00:00:00.000+00:00');
  });
});

describe('DailyLogFile', () => {
  const dateOf = (ms: number) => logClock('UTC')(ms).date;
  let dir: string;
  let now: number;
  const file = (retentionDays = 0) => new DailyLogFile(join(dir, 'logs'), 'app', dateOf, retentionDays, () => now);
  const read = (name: string) => readFileSync(join(dir, 'logs', name), 'utf8');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'log-file-'));
    now = Date.UTC(2026, 9, 4, 23, 59, 30);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates the folder and appends to the file of the day', () => {
    const log = file();
    log.write('one\n');
    log.write('two\n');
    log.end();

    // A restart on the same day keeps what was written
    const again = file();
    again.write('three\n');
    again.end();

    expect(readdirSync(join(dir, 'logs'))).toEqual(['app-2026-10-04.log']);
    expect(read('app-2026-10-04.log')).toBe('one\ntwo\nthree\n');
  });

  it('starts a new file when the day changes', () => {
    const log = file();
    log.write('before midnight\n');
    now += 20_000; // 23:59:50
    log.write('still before\n');
    now += 20_000; // 00:00:10
    log.write('after midnight\n');
    log.end();

    expect(read('app-2026-10-04.log')).toBe('before midnight\nstill before\n');
    expect(read('app-2026-10-05.log')).toBe('after midnight\n');
  });

  it('uses the date of the log time zone, not of the machine', () => {
    const log = new DailyLogFile(
      join(dir, 'logs'),
      'app',
      (ms) => logClock('Asia/Kuala_Lumpur')(ms).date,
      0,
      () => now,
    );
    log.write('line\n');
    log.end();

    // 23:59 UTC on the 4th is 07:59 on the 5th in Kuala Lumpur
    expect(readdirSync(join(dir, 'logs'))).toEqual(['app-2026-10-05.log']);
  });

  it('deletes its files older than the retention when a new file is started, and nothing else', () => {
    const old = file();
    old.write('x\n');
    old.end();
    for (const name of ['app-2026-09-30.log', 'app-2026-10-02.log', 'error-2026-09-01.log', 'app-notes.log', 'app.log'])
      writeFileSync(join(dir, 'logs', name), 'old\n');

    now += 60_000; // the 5th
    const log = file(3);
    log.write('y\n');
    log.end();

    expect(readdirSync(join(dir, 'logs')).sort()).toEqual([
      'app-2026-10-02.log', // 3 days old: kept
      'app-2026-10-04.log',
      'app-2026-10-05.log',
      'app-notes.log',
      'app.log',
      'error-2026-09-01.log', // another log's file
    ]);
  });

  it('keeps every file without a retention', () => {
    const old = file();
    old.write('x\n');
    old.end();
    writeFileSync(join(dir, 'logs', 'app-2020-01-01.log'), 'old\n');

    now += 60_000;
    const log = file();
    log.write('y\n');
    log.end();

    expect(readdirSync(join(dir, 'logs'))).toContain('app-2020-01-01.log');
  });
});
