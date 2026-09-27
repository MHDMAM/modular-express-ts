import { z } from 'zod';

/**
 * Configuration comes from environment variables only (Twelve-Factor), validated with zod when the app starts.
 * Locally, `npm run dev` / `npm start` load `.env` (see `.env.example`). Each connector declares its own variables
 * next to its code (e.g. `kafkaConfigFromEnv` in `@connectors/kafka/kafka`).
 */

export class ConfigError extends Error {
  override name = 'ConfigError';
}

type Env = Record<string, string | undefined>;

/** Unset and empty variables (`FOO=` in `.env`) both mean "use the default". */
const orDefault =
  <T>(defaultValue: T) =>
  (value: unknown) =>
    value === undefined || value === '' ? defaultValue : value;

const TRUE = ['true', '1', 'yes'];
const FALSE = ['false', '0', 'no'];

/** `true`/`false`, `1`/`0` or `yes`/`no` (case-insensitive); anything else is rejected instead of read as true. */
export const envBoolean = (defaultValue: boolean) =>
  z.preprocess(
    (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
    z.preprocess(
      orDefault(String(defaultValue)),
      z.enum([...TRUE, ...FALSE] as [string, ...string[]]).transform((value) => TRUE.includes(value)),
    ),
  );

export const envNumber = (defaultValue: number, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) =>
  z.preprocess(orDefault(defaultValue), z.coerce.number().int().min(min).max(max));

export const envString = (defaultValue: string) => z.preprocess(orDefault(defaultValue), z.string().trim().min(1));

/** Optional string: unset or empty becomes `undefined`. */
export const envOptional = () => z.preprocess(orDefault(undefined), z.string().optional());

/** Comma-separated list, e.g. `KAFKA_BROKERS=b1:9092,b2:9092`. */
export const envList = (defaultValue: string) =>
  z.preprocess(
    orDefault(defaultValue),
    z.string().transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );

/** Validates `env` against `schema`, throwing a `ConfigError` that lists every invalid variable. */
export function parseEnv<T extends z.ZodType>(schema: T, env: Env = process.env): z.output<T> {
  const result = schema.safeParse(env);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => `  - ${issue.path.join('.') || '(env)'}: ${issue.message}`);
  throw new ConfigError(`Invalid environment variables:\n${issues.join('\n')}`);
}

const coreEnv = z
  .object({
    NODE_ENV: z.preprocess(orDefault('development'), z.enum(['development', 'test', 'production'])),
    APP_NAME: envString('modular-express-ts'),
    PORT: envNumber(3000, { max: 65535 }),
    API_BASE_PATH: envString('/api/v1'),
    /** Router files auto-loaded from `src/` (`dist/` once built). */
    ROUTES_GLOB: envString('modules/**/routerV1.{js,ts}'),
    STATUS_PREFIX: envString('APP'),
    LOG_DIR: envString('logs'),
    SHUTDOWN_TIMEOUT_MS: envNumber(10_000),
    CONNECTOR_INIT_TIMEOUT_MS: envNumber(30_000, { min: 1 }),
    CONNECTOR_CLOSE_TIMEOUT_MS: envNumber(5_000, { min: 1 }),
    CONNECTOR_MONITOR_INTERVAL_MS: envNumber(10_000, { min: 1 }),
    SSL_ENABLED: envBoolean(false),
    SSL_KEY_PATH: envString('ssl_cert/server.key'),
    SSL_CERT_PATH: envString('ssl_cert/server.cer'),
    SSL_MIN_VERSION: z.preprocess(orDefault('TLSv1.3'), z.enum(['TLSv1.2', 'TLSv1.3'])),
  })
  .transform((env) => ({
    env: env.NODE_ENV,
    appName: env.APP_NAME,
    port: env.PORT,
    baseUrl: env.API_BASE_PATH,
    routesGlob: env.ROUTES_GLOB,
    statusPrefix: env.STATUS_PREFIX,
    logDir: env.LOG_DIR,
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    connectors: {
      initTimeoutMs: env.CONNECTOR_INIT_TIMEOUT_MS,
      closeTimeoutMs: env.CONNECTOR_CLOSE_TIMEOUT_MS,
      monitorIntervalMs: env.CONNECTOR_MONITOR_INTERVAL_MS,
    },
    ssl: {
      enabled: env.SSL_ENABLED,
      /** Relative paths resolve against the working directory. */
      keyPath: env.SSL_KEY_PATH,
      certPath: env.SSL_CERT_PATH,
      minVersion: env.SSL_MIN_VERSION,
    },
  }));

export type AppConfig = z.output<typeof coreEnv>;

export function loadConfig(env: Env = process.env): AppConfig {
  return parseEnv(coreEnv, env);
}

/** The application configuration, validated once at startup. */
const config = loadConfig();

export default config;
