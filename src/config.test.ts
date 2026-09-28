import { ConfigError, envBoolean, envList, envNumber, envOptional, envString, loadConfig, parseEnv } from '#config';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

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
      logDir: 'logs',
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

  it('rejects invalid values', () => {
    expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrow('NODE_ENV');
    expect(() => loadConfig({ PORT: '70000' })).toThrow('PORT');
    expect(() => loadConfig({ SSL_MIN_VERSION: 'TLSv1.0' })).toThrow('SSL_MIN_VERSION');
  });
});
