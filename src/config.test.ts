import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  ConfigError,
  envBoolean,
  envList,
  envNumber,
  envOptional,
  envString,
  loadConfig,
  loadOrExit,
  parseEnv,
} from '#config';
import { failStartup } from '#core/fail-startup';

vi.mock('#core/fail-startup', () => ({ failStartup: vi.fn() }));
afterEach(() => vi.mocked(failStartup).mockClear());

const schema = z.object({
  FLAG: envBoolean(false),
  COUNT: envNumber(5, { min: 1, max: 10 }),
  NAME: envString('default-name'),
  LIST: envList('a,b'),
  SECRET: envOptional(),
});

describe('env helpers', () => {
  it('use defaults for unset and empty variables', () => {
    const defaults = { FLAG: false, COUNT: 5, NAME: 'default-name', LIST: ['a', 'b'], SECRET: undefined };

    expect(parseEnv(schema, {})).toEqual(defaults);
    expect(parseEnv(schema, { FLAG: '', COUNT: '', NAME: '', LIST: '', SECRET: '' })).toEqual(defaults);
  });

  it('parse booleans strictly (case-insensitive)', () => {
    for (const value of ['true', 'TRUE', '1', 'yes']) expect(parseEnv(schema, { FLAG: value }).FLAG).toBe(true);
    for (const value of ['false', 'False', '0', 'no']) expect(parseEnv(schema, { FLAG: value }).FLAG).toBe(false);
    expect(() => parseEnv(schema, { FLAG: 'ture' })).toThrow(ConfigError);
  });

  it('parse integers within their bounds', () => {
    expect(parseEnv(schema, { COUNT: '7' }).COUNT).toBe(7);
    expect(() => parseEnv(schema, { COUNT: 'seven' })).toThrow('COUNT');
    expect(() => parseEnv(schema, { COUNT: '11' })).toThrow('COUNT');
    expect(() => parseEnv(schema, { COUNT: '1.5' })).toThrow('COUNT');
  });

  it('split comma-separated lists and trim entries', () => {
    expect(parseEnv(schema, { LIST: ' x , y,,z ' }).LIST).toEqual(['x', 'y', 'z']);
  });

  it('report every invalid variable at once', () => {
    let error: unknown;
    try {
      parseEnv(schema, { FLAG: 'maybe', COUNT: 'many' });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toMatch(/Invalid environment variables:\n {2}- FLAG: .+\n {2}- COUNT: .+/);
  });
});

describe('loadConfig', () => {
  it('has working defaults', () => {
    expect(loadConfig({})).toEqual({
      env: 'development',
      appName: 'modular-express-ts',
      port: 3000,
      baseUrl: '/api/v1',
      routesGlob: 'modules/**/*.routes.{js,ts}',
      statusPrefix: 'APP',
      log: { dir: 'logs', level: 'debug', output: 'both', timeZone: undefined, retentionDays: 0 },
      shutdownTimeoutMs: 10_000,
      connectors: { initTimeoutMs: 30_000, closeTimeoutMs: 5_000, monitorIntervalMs: 10_000 },
      ssl: { enabled: false, keyPath: 'ssl_cert/server.key', certPath: 'ssl_cert/server.cer', minVersion: 'TLSv1.3' },
    });
  });

  it('reads the environment', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      APP_NAME: 'orders-api',
      PORT: '8080',
      API_BASE_PATH: '/api/v2',
      SSL_ENABLED: 'true',
      SSL_MIN_VERSION: 'TLSv1.2',
    });

    expect(config).toMatchObject({
      env: 'production',
      appName: 'orders-api',
      port: 8080,
      baseUrl: '/api/v2',
      ssl: { enabled: true, minVersion: 'TLSv1.2' },
    });
  });

  it('logs to daily files at info level outside development, unless set otherwise', () => {
    expect(loadConfig({ NODE_ENV: 'production' }).log).toMatchObject({ level: 'info', output: 'file' });
    expect(loadConfig({ NODE_ENV: 'test' }).log).toMatchObject({ level: 'info', output: 'file' });
    expect(
      loadConfig({
        NODE_ENV: 'production',
        LOG_DIR: '/var/log/app',
        LOG_LEVEL: 'warn',
        LOG_OUTPUT: 'stdout',
        LOG_TIMEZONE: 'Asia/Kuala_Lumpur',
        LOG_RETENTION_DAYS: '30',
      }).log,
    ).toEqual({
      dir: '/var/log/app',
      level: 'warn',
      output: 'stdout',
      timeZone: 'Asia/Kuala_Lumpur',
      retentionDays: 30,
    });
    // Empty, as in a copied .env.example: the defaults
    expect(loadConfig({ LOG_LEVEL: '', LOG_OUTPUT: '', LOG_TIMEZONE: '' }).log).toMatchObject({
      level: 'debug',
      output: 'both',
      timeZone: undefined,
    });
  });

  it('rejects invalid values', () => {
    expect(() => loadConfig({ LOG_TIMEZONE: 'Mars/Olympus' })).toThrow('LOG_TIMEZONE');
    expect(() => loadConfig({ LOG_LEVEL: 'verbose' })).toThrow('LOG_LEVEL');
    expect(() => loadConfig({ LOG_OUTPUT: 'console' })).toThrow('LOG_OUTPUT');
    expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrow('NODE_ENV');
    expect(() => loadConfig({ PORT: '70000' })).toThrow('PORT');
    expect(() => loadConfig({ SSL_MIN_VERSION: 'TLSv1.0' })).toThrow('SSL_MIN_VERSION');
  });
});

describe('loadOrExit', () => {
  it('returns what the loader returns', () => {
    expect(loadOrExit(() => 42)).toBe(42);
    expect(failStartup).not.toHaveBeenCalled();
  });

  it('stops the process with the message of a ConfigError', () => {
    // The real failStartup exits; the mock returns, so the error is thrown on
    expect(() => loadOrExit(() => parseEnv(z.object({ PORT: envNumber(1) }), { PORT: 'abc' }))).toThrow(ConfigError);

    expect(failStartup).toHaveBeenCalledTimes(1);
    expect(vi.mocked(failStartup).mock.calls[0][0]).toMatch(/^Invalid environment variables:\n {2}- PORT: /);
  });

  it('leaves other errors alone', () => {
    expect(() =>
      loadOrExit(() => {
        throw new TypeError('a bug');
      }),
    ).toThrow('a bug');
    expect(failStartup).not.toHaveBeenCalled();
  });
});
