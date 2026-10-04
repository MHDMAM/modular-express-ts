import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { applyConfigFile, ConfigFileError, parseConfigFile } from './config-file.js';

const dirs: string[] = [];

/** A working directory holding `files` (name → content). */
function workingDir(files: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'config-file-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('parseConfigFile', () => {
  it('reads strings, numbers and booleans as strings and leaves empty values out', () => {
    const text = JSON.stringify({ APP_NAME: 'orders', PORT: 8080, SSL_ENABLED: true, LOG_LEVEL: '' });

    expect(parseConfigFile(text, 'config.json')).toEqual({ APP_NAME: 'orders', PORT: '8080', SSL_ENABLED: 'true' });
  });

  it('rejects invalid JSON and anything but an object', () => {
    expect(() => parseConfigFile('{ PORT: 1 }', 'config.json')).toThrow(/config\.json is not valid JSON/);
    for (const text of ['[]', 'null', '"PORT"']) {
      expect(() => parseConfigFile(text, 'config.json')).toThrow(ConfigFileError);
    }
  });

  it('names every value that is not a string, number or boolean', () => {
    const text = JSON.stringify({ PORT: 1, KAFKA_BROKERS: ['b1', 'b2'], mssql: { host: 'db' }, LOG_DIR: null });

    expect(() => parseConfigFile(text, 'config.json')).toThrow(/: KAFKA_BROKERS, mssql, LOG_DIR$/);
  });
});

describe('applyConfigFile', () => {
  it('does nothing without a config file', () => {
    const env = { PORT: '3000' };

    applyConfigFile(env, workingDir());

    expect(env).toEqual({ PORT: '3000' });
  });

  it('copies config.json of the working directory into the environment', () => {
    const env: Record<string, string | undefined> = { NODE_ENV: 'production' };

    applyConfigFile(env, workingDir({ 'config.json': { PORT: 8080, LOG_OUTPUT: 'file' } }));

    expect(env).toEqual({ NODE_ENV: 'production', PORT: '8080', LOG_OUTPUT: 'file' });
  });

  it('reads the file named by CONFIG_FILE, and fails when it is missing', () => {
    const dir = workingDir({ 'host.json': { PORT: 8080 }, 'config.json': { PORT: 9090 } });
    const env: Record<string, string | undefined> = { CONFIG_FILE: 'host.json' };

    applyConfigFile(env, dir);

    expect(env.PORT).toBe('8080');
    expect(() => applyConfigFile({ CONFIG_FILE: 'missing.json' }, dir)).toThrow(
      /CONFIG_FILE not found: .*missing\.json/,
    );
  });

  it('accepts a variable set to the same value in both, and fills in empty ones', () => {
    const env: Record<string, string | undefined> = { PORT: '8080', LOG_DIR: '' };

    applyConfigFile(env, workingDir({ 'config.json': { PORT: 8080, LOG_DIR: '/var/log/app' } }));

    expect(env).toEqual({ PORT: '8080', LOG_DIR: '/var/log/app' });
  });

  it('fails on variables set differently in the file and the environment, without showing values', () => {
    const env = { PORT: '3000', MSSQL_PASSWORD: 'from-env', LOG_DIR: 'logs' };
    const dir = workingDir({ 'config.json': { PORT: 8080, MSSQL_PASSWORD: 'from-file', LOG_DIR: 'logs' } });

    let error: unknown;
    try {
      applyConfigFile(env, dir);
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(ConfigFileError);
    expect((error as Error).message).toMatch(/with different values: PORT, MSSQL_PASSWORD\./);
    expect((error as Error).message).not.toMatch(/from-env|from-file/);
    // Nothing was applied
    expect(env).toEqual({ PORT: '3000', MSSQL_PASSWORD: 'from-env', LOG_DIR: 'logs' });
  });
});
