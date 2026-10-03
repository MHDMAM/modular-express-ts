import type { createClient } from 'redis';
import { z } from 'zod';

import { envBoolean, envString, parseEnv } from '#config';
import type { Connector } from '#core/lifecycle';
import logger from '#core/logger';

import type { Cache } from '../cache.js';

export interface RedisConfig {
  enabled: boolean;
  /** `redis[s]://[[username][:password]@][host][:port][/db-number]`; works with Redis and Valkey. */
  url: string;
  /** Prepended to every key used through the `Cache` methods, e.g. `my-app:`. */
  keyPrefix: string;
}

export type RedisClient = ReturnType<typeof createClient<{}, {}, {}, 3, {}>>;

/**
 * Redis (or Valkey) client with a JSON `Cache` on top; use `raw` for any other command.
 *
 * ```ts
 * import redis from '#connectors/redis/redis';
 * await redis.set(`user:${id}`, user, 60_000);
 * await redis.raw.incr('visits');
 * ```
 */
export class RedisConnector implements Connector, Cache {
  readonly name = 'redis';
  private client?: RedisClient;
  /** Incremented by init() and close(), so an init() still loading the client knows it was closed meanwhile. */
  private generation = 0;

  constructor(private readonly config: RedisConfig) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  async init(): Promise<void> {
    const generation = ++this.generation;
    // Loaded here, not at import time: a disabled connector never loads the client
    const { createClient: create } = await import('redis');
    if (generation !== this.generation) throw new Error('Redis connector was closed during init');
    // Without the offline queue, commands fail at once while the server is unreachable instead of waiting for it:
    // a cache that is down must not hold requests
    const client: RedisClient = create({ url: this.config.url, disableOfflineQueue: true });
    // Without an error listener, a dropped connection would crash the process; the client reconnects on its own
    client.on('error', (error) => logger.error({ info: 'Redis client error', error }));
    // Kept before connecting so close() can stop a connection that is still retrying
    this.client = client;
    await client.connect();
    // connect() resolves, not rejects, when close() destroyed the client while it was still trying
    if (generation !== this.generation) throw new Error('Redis connector was closed during init');
  }

  async close(): Promise<void> {
    this.generation++;
    const client = this.client;
    this.client = undefined;
    if (!client?.isOpen) return;
    // A ready client finishes pending commands; one still (re)connecting would wait forever, so it is destroyed
    if (client.isReady) await client.close();
    else client.destroy();
  }

  isReady(): boolean {
    return this.client?.isReady ?? false;
  }

  /** The underlying node-redis client. Keys used here are not prefixed. */
  get raw(): RedisClient {
    if (!this.config.enabled) throw new Error('Redis connector is disabled (set REDIS_ENABLED=true)');
    if (!this.client) throw new Error('Redis connector is not ready');
    return this.client;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const value = await this.raw.get(this.key(key));
    if (value === null) return undefined;
    try {
      return JSON.parse(value.toString()) as T;
    } catch {
      // Written by something else (e.g. through `raw`); the value itself is not reported
      throw new Error(`Redis: the value of "${key}" is not JSON`);
    }
  }

  async set<T>(key: string, value: T, ttlMs = 0): Promise<void> {
    if (value === undefined) throw new TypeError('Redis: cannot cache undefined');
    // The server only takes whole milliseconds
    const options = ttlMs > 0 ? { expiration: { type: 'PX' as const, value: Math.ceil(ttlMs) } } : undefined;
    await this.raw.set(this.key(key), JSON.stringify(value), options);
  }

  async delete(key: string): Promise<void> {
    await this.raw.del(this.key(key));
  }

  private key(key: string): string {
    return `${this.config.keyPrefix}${key}`;
  }
}

const redisEnv = z
  .object({
    REDIS_ENABLED: envBoolean(false),
    REDIS_URL: envString('redis://localhost:6379').pipe(
      z.string().regex(/^rediss?:\/\//, 'must start with redis:// or rediss://'),
    ),
    REDIS_KEY_PREFIX: z.string().default(''),
  })
  .transform((env): RedisConfig => ({
    enabled: env.REDIS_ENABLED,
    url: env.REDIS_URL,
    keyPrefix: env.REDIS_KEY_PREFIX,
  }));

/** Reads the `REDIS_*` environment variables. */
export function redisConfigFromEnv(env: Record<string, string | undefined> = process.env): RedisConfig {
  return parseEnv(redisEnv, env);
}

export default new RedisConnector(redisConfigFromEnv());
