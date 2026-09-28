import logger from '#core/logger';
import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisConfig, RedisConnector, redisConfigFromEnv } from './redis';

/** In-memory stand-in for a node-redis client. */
class FakeRedisClient extends EventEmitter {
  store = new Map<string, string>();
  isOpen = false;
  isReady = false;
  connect = vi.fn(async () => {
    this.isOpen = this.isReady = true;
    return this;
  });
  close = vi.fn(async () => {
    this.isOpen = this.isReady = false;
  });
  destroy = vi.fn(() => {
    this.isOpen = this.isReady = false;
  });
  get = vi.fn(async (key: string) => this.store.get(key) ?? null);
  set = vi.fn(async (key: string, value: string, _options?: unknown) => {
    this.store.set(key, value);
    return 'OK';
  });
  del = vi.fn(async (key: string) => Number(this.store.delete(key)));
}

let client: FakeRedisClient;
const createClient = vi.fn((_options: unknown) => (client = new FakeRedisClient()));
/** Set when the mocked client library is first imported. */
const library = vi.hoisted(() => ({ loaded: false }));

vi.mock('redis', () => (library.loaded = true) && { createClient: (options: unknown) => createClient(options) });

const baseConfig: RedisConfig = { enabled: true, url: 'redis://cache:6379/1', keyPrefix: 'app:' };

async function connected(config: RedisConfig = baseConfig) {
  const redis = new RedisConnector(config);
  await redis.init();
  return redis;
}

beforeEach(() => vi.clearAllMocks());

describe('RedisConnector', () => {
  // Must run first: the library is imported once per test file
  it('does not load the client library until init', async () => {
    const connector = new RedisConnector(baseConfig);
    expect(library.loaded).toBe(false);

    await connector.init();

    expect(library.loaded).toBe(true);
    await connector.close();
  });

  it('connects with the configured URL', async () => {
    const redis = await connected();

    expect(createClient).toHaveBeenCalledWith({ url: 'redis://cache:6379/1' });
    expect(client.connect).toHaveBeenCalled();
    expect(redis.isReady()).toBe(true);
  });

  it('logs client errors instead of crashing the process', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    await connected();

    expect(() => client.emit('error', new Error('connection lost'))).not.toThrow();
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ info: 'Redis client error' }));
    error.mockRestore();
  });

  it('reports readiness from the client (e.g. while reconnecting)', async () => {
    const redis = new RedisConnector(baseConfig);
    expect(redis.isReady()).toBe(false);

    await redis.init();
    client.isReady = false;

    expect(redis.isReady()).toBe(false);
  });

  it('stores values as JSON under the key prefix and reads them back', async () => {
    const redis = await connected();

    await redis.set('user:1', { name: 'Ada', roles: ['admin'] });

    expect(client.store.get('app:user:1')).toBe('{"name":"Ada","roles":["admin"]}');
    expect(await redis.get('user:1')).toEqual({ name: 'Ada', roles: ['admin'] });
  });

  it('sets a millisecond expiry only when a TTL is given', async () => {
    const redis = await connected();

    await redis.set('a', 1, 60_000);
    await redis.set('b', 2);

    expect(client.set).toHaveBeenNthCalledWith(1, 'app:a', '1', { expiration: { type: 'PX', value: 60_000 } });
    expect(client.set).toHaveBeenNthCalledWith(2, 'app:b', '2', undefined);
  });

  it('returns undefined for missing keys and deletes keys', async () => {
    const redis = await connected();
    await redis.set('user:1', 'x');

    expect(await redis.get('missing')).toBeUndefined();
    await redis.delete('user:1');
    expect(await redis.get('user:1')).toBeUndefined();
    expect(client.del).toHaveBeenCalledWith('app:user:1');
  });

  it('refuses to cache undefined', async () => {
    const redis = await connected();

    await expect(redis.set('key', undefined)).rejects.toThrow('cannot cache undefined');
  });

  it('exposes the raw client for other commands', async () => {
    const redis = await connected();

    expect(redis.raw).toBe(client);
  });

  it('throws when used before init or after close', async () => {
    const redis = new RedisConnector(baseConfig);
    expect(() => redis.raw).toThrow('not ready');

    await redis.init();
    await redis.close();

    await expect(redis.get('key')).rejects.toThrow('not ready');
  });

  it('closes the client gracefully', async () => {
    const redis = await connected();
    const connection = client;

    await redis.close();
    await redis.close();

    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(redis.isReady()).toBe(false);
  });

  it('destroys a client that is still connecting instead of waiting for it', async () => {
    const redis = new RedisConnector(baseConfig);
    createClient.mockImplementationOnce(() => {
      client = new FakeRedisClient();
      client.connect.mockImplementation(() => {
        client.isOpen = true; // open, retrying, never ready
        return new Promise(() => undefined);
      });
      return client;
    });

    void redis.init();
    await vi.waitFor(() => expect(client.connect).toHaveBeenCalled());
    await redis.close();

    expect(client.destroy).toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();
  });

  it('aborts an init still loading the client when closed, so no client is left connecting', async () => {
    const redis = new RedisConnector(baseConfig);

    const initializing = redis.init();
    await redis.close();

    await expect(initializing).rejects.toThrow('closed during init');
    expect(createClient).not.toHaveBeenCalled();
    expect(redis.isReady()).toBe(false);
  });

  it('does not log cached values', async () => {
    const spies = (['info', 'debug', 'error', 'warn'] as const).map((level) => vi.spyOn(logger, level));
    const redis = await connected();

    await redis.set('user:1', { email: 'ada@example.com' });
    await redis.get('user:1');

    expect(JSON.stringify(spies.map((spy) => spy.mock.calls))).not.toContain('ada@example.com');
    spies.forEach((spy) => spy.mockRestore());
  });
});

describe('redisConfigFromEnv', () => {
  it('has defaults and reads the environment', () => {
    expect(redisConfigFromEnv({})).toEqual({ enabled: false, url: 'redis://localhost:6379', keyPrefix: '' });
    expect(
      redisConfigFromEnv({
        REDIS_ENABLED: '1',
        REDIS_URL: 'rediss://user:pass@cache:6380/2',
        REDIS_KEY_PREFIX: 'app:',
      }),
    ).toEqual({ enabled: true, url: 'rediss://user:pass@cache:6380/2', keyPrefix: 'app:' });
  });

  it('rejects URLs that are not redis:// or rediss://', () => {
    expect(() => redisConfigFromEnv({ REDIS_URL: 'http://cache:6379' })).toThrow('REDIS_URL');
  });
});
