import type { LifecycleState } from 'hazelcast-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import logger from '#core/logger';

import { HazelcastConfig, hazelcastConfigFromEnv, HazelcastConnector } from './hazelcast.js';

/** In-memory stand-in for a Hazelcast IMap, recording the TTL of each entry. */
class FakeMap {
  entries = new Map<string, unknown>();
  ttls = new Map<string, number | undefined>();
  get = vi.fn(async (key: string) => (this.entries.has(key) ? this.entries.get(key) : null));
  set = vi.fn(async (key: string, value: unknown, ttl?: number) => {
    this.entries.set(key, value);
    this.ttls.set(key, ttl);
  });
  delete = vi.fn(async (key: string) => void this.entries.delete(key));
}

const fake = {
  clientConfig: undefined as any,
  /** Awaited before the client is returned, so a test can close the connector while the client starts. */
  starting: undefined as undefined | Promise<void>,
  maps: new Map<string, FakeMap>(),
  getMap: vi.fn(async (name: string) => {
    if (!fake.maps.has(name)) fake.maps.set(name, new FakeMap());
    return fake.maps.get(name);
  }),
  shutdown: vi.fn(async () => undefined),
  /** Emits a lifecycle event to every configured listener, like the client does. */
  emit(state: LifecycleState) {
    fake.clientConfig.lifecycleListeners.forEach((listener: (s: LifecycleState) => void) => listener(state));
  },
};

/** Set when the mocked client library is first imported. */
const library = vi.hoisted(() => ({ loaded: false }));

// Only `Client` is used at runtime; the real library is not loaded (it takes seconds on a cold install)
vi.mock(
  'hazelcast-client',
  () =>
    (library.loaded = true) && {
      Client: {
        newHazelcastClient: vi.fn(async (clientConfig: any) => {
          fake.clientConfig = clientConfig;
          await fake.starting;
          // A client that blocks until connected has emitted CONNECTED when it is returned
          if (!clientConfig.connectionStrategy?.asyncStart) fake.emit('CONNECTED' as LifecycleState);
          return { getMap: fake.getMap, shutdown: fake.shutdown };
        }),
      },
    },
);

const baseConfig: HazelcastConfig = {
  enabled: true,
  mapName: 'cache',
  client: { clusterName: 'dev', network: { clusterMembers: ['127.0.0.1:5701'] } },
};

beforeEach(() => {
  vi.clearAllMocks();
  fake.maps.clear();
  fake.clientConfig = undefined;
  fake.starting = undefined;
});

async function connected(config: HazelcastConfig = baseConfig) {
  const hazelcast = new HazelcastConnector(config);
  await hazelcast.init();
  return hazelcast;
}

describe('HazelcastConnector', () => {
  // Must run first: the library is imported once per test file
  it('does not load the client library until init', async () => {
    const connector = new HazelcastConnector(baseConfig);
    expect(library.loaded).toBe(false);

    await connector.init();

    expect(library.loaded).toBe(true);
    await connector.close();
  });

  it('passes the client config through and adds its lifecycle listener, keeping user listeners', async () => {
    const userListener = vi.fn();
    await connected({ ...baseConfig, client: { ...baseConfig.client, lifecycleListeners: [userListener] } });

    expect(fake.clientConfig).toMatchObject(baseConfig.client);
    expect(fake.clientConfig.lifecycleListeners).toHaveLength(2);
    fake.emit('CONNECTED' as LifecycleState);
    expect(userListener).toHaveBeenCalledWith('CONNECTED' as LifecycleState);
  });

  it('follows the connection state for readiness', async () => {
    const hazelcast = new HazelcastConnector(baseConfig);
    expect(hazelcast.isReady()).toBe(false);

    await hazelcast.init();
    expect(hazelcast.isReady()).toBe(true);

    fake.emit('DISCONNECTED' as LifecycleState);
    expect(hazelcast.isReady()).toBe(false);

    fake.emit('CONNECTED' as LifecycleState);
    expect(hazelcast.isReady()).toBe(true);
  });

  it('stores, reads and deletes values in the default map, with TTL in milliseconds', async () => {
    const hazelcast = await connected();

    await hazelcast.set('user:1', { name: 'Ada' }, 60_000);
    await hazelcast.set('user:2', { name: 'Bob' });

    expect(await hazelcast.get('user:1')).toEqual({ name: 'Ada' });
    expect(fake.maps.get('cache')!.entries.get('user:1')).toBe('{"name":"Ada"}');
    expect(fake.maps.get('cache')!.ttls.get('user:1')).toBe(60_000);
    expect(fake.maps.get('cache')!.ttls.get('user:2')).toBe(0);

    await hazelcast.delete('user:1');
    expect(await hazelcast.get('user:1')).toBeUndefined();
  });

  it('stores values as JSON text, so arrays and null survive', async () => {
    const hazelcast = await connected();

    await hazelcast.set('list', [1, 'two', null]);
    await hazelcast.set('nothing', null);

    expect(await hazelcast.get('list')).toEqual([1, 'two', null]);
    expect(await hazelcast.get('nothing')).toBeNull();
    await expect(hazelcast.set('key', undefined)).rejects.toThrow('cannot cache undefined');
  });

  it('reports a value that is not JSON without showing it', async () => {
    const hazelcast = await connected();
    const map = await hazelcast.map('cache');
    await map.set('text', 'secret-token');
    await map.set('object', { native: true });

    const reading = hazelcast.get('text');
    await expect(reading).rejects.toThrow('the value of "text" is not JSON');
    await expect(reading).rejects.not.toThrow('secret-token');
    await expect(hazelcast.get('object')).rejects.toThrow('the value of "object" is not JSON');
  });

  it('returns undefined for missing keys (the client returns null)', async () => {
    const hazelcast = await connected();

    expect(await hazelcast.get('missing')).toBeUndefined();
  });

  it('returns a separate map per name and fetches each map only once', async () => {
    const hazelcast = await connected();

    const sessions = await hazelcast.map('sessions');
    const carts = await hazelcast.map('carts');
    await hazelcast.map('sessions');

    expect(sessions).not.toBe(carts);
    expect(fake.getMap.mock.calls.map(([name]) => name)).toEqual(['sessions', 'carts']);
  });

  it("routes the client's own logs through the application logger, unless a logger is configured", async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    await connected();

    fake.clientConfig.customLogger.warn('ConnectionManager', 'connection lost');
    fake.clientConfig.customLogger.log(2, 'Heartbeat', 'no heartbeat', { member: 'a' });

    expect(warn).toHaveBeenCalledWith({ info: 'Hazelcast client: connection lost', source: 'ConnectionManager' });
    expect(warn).toHaveBeenCalledWith({
      info: 'Hazelcast client: no heartbeat',
      source: 'Heartbeat',
      furtherInfo: { member: 'a' },
    });
    warn.mockRestore();

    const customLogger = {} as HazelcastConfig['client']['customLogger'];
    await connected({ ...baseConfig, client: { ...baseConfig.client, customLogger } });
    expect(fake.clientConfig.customLogger).toBe(customLogger);
  });

  it('waits for the first connection of a client that starts asynchronously', async () => {
    const hazelcast = new HazelcastConnector({
      ...baseConfig,
      client: { ...baseConfig.client, connectionStrategy: { asyncStart: true } },
    });
    let settled = false;

    const initializing = hazelcast.init().then(() => (settled = true));
    await vi.waitFor(() => expect(fake.clientConfig).toBeDefined());
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(hazelcast.isReady()).toBe(false);

    fake.emit('CONNECTED' as LifecycleState);
    await initializing;
    expect(hazelcast.isReady()).toBe(true);
  });

  it('fails an init that is closed while waiting for the cluster, and shuts the client down', async () => {
    const hazelcast = new HazelcastConnector({
      ...baseConfig,
      client: { ...baseConfig.client, connectionStrategy: { asyncStart: true } },
    });

    const initializing = hazelcast.init();
    const failed = expect(initializing).rejects.toThrow('closed during init');
    await vi.waitFor(() => expect(fake.clientConfig).toBeDefined());
    await new Promise((resolve) => setImmediate(resolve));
    await hazelcast.close();

    await failed;
    expect(fake.shutdown).toHaveBeenCalledTimes(1);
    expect(hazelcast.isReady()).toBe(false);
  });

  it('shuts down a client that finished starting after the connector was closed', async () => {
    let started!: () => void;
    fake.starting = new Promise((resolve) => (started = resolve));
    const hazelcast = new HazelcastConnector(baseConfig);

    const initializing = hazelcast.init();
    const failed = expect(initializing).rejects.toThrow('closed during init');
    await vi.waitFor(() => expect(fake.clientConfig).toBeDefined());
    await hazelcast.close();
    expect(fake.shutdown).not.toHaveBeenCalled();
    started();

    await failed;
    expect(fake.shutdown).toHaveBeenCalledTimes(1);
  });

  it('asks for a map again after it could not be fetched', async () => {
    const hazelcast = await connected();
    fake.getMap.mockRejectedValueOnce(new Error('No connection found to cluster'));

    await expect(hazelcast.get('key')).rejects.toThrow('No connection found');
    await hazelcast.set('key', 'value');

    expect(await hazelcast.get('key')).toBe('value');
  });

  it('says so when it is disabled', async () => {
    const hazelcast = new HazelcastConnector({ ...baseConfig, enabled: false });

    await expect(hazelcast.get('key')).rejects.toThrow('disabled');
  });

  it('throws when used before init or after close', async () => {
    const hazelcast = new HazelcastConnector(baseConfig);
    expect(() => hazelcast.map()).toThrow('not ready');

    await hazelcast.init();
    await hazelcast.close();

    await expect(hazelcast.get('key')).rejects.toThrow('not ready');
  });

  it('shuts the client down on close and clears cached maps', async () => {
    const hazelcast = await connected();
    await hazelcast.map('sessions');

    await hazelcast.close();

    expect(fake.shutdown).toHaveBeenCalled();
    expect(hazelcast.isReady()).toBe(false);
    await hazelcast.init();
    await hazelcast.map('sessions');
    expect(fake.getMap).toHaveBeenCalledTimes(2);
  });

  it('does not log cached values', async () => {
    const spies = (['info', 'debug', 'error', 'warn'] as const).map((level) => vi.spyOn(logger, level));
    const hazelcast = await connected();

    await hazelcast.set('user:1', { email: 'ada@example.com' });
    await hazelcast.get('user:1');

    expect(JSON.stringify(spies.map((spy) => spy.mock.calls))).not.toContain('ada@example.com');
    spies.forEach((spy) => spy.mockRestore());
  });
});

describe('hazelcastConfigFromEnv', () => {
  it('builds the client config from the environment', () => {
    const config = hazelcastConfigFromEnv({
      HAZELCAST_ENABLED: 'true',
      HAZELCAST_CLUSTER_NAME: 'prod',
      HAZELCAST_MEMBERS: 'hz1:5701,hz2:5701',
      HAZELCAST_MAP_NAME: 'sessions',
    });

    expect(config).toMatchObject({
      enabled: true,
      mapName: 'sessions',
      client: {
        clusterName: 'prod',
        network: { clusterMembers: ['hz1:5701', 'hz2:5701'] },
        // Starts in the background and never gives up: the connector waits for it and can stop it
        connectionStrategy: { asyncStart: true, connectionRetry: { clusterConnectTimeoutMillis: -1 } },
      },
    });
  });

  it('is disabled by default with a local cluster', () => {
    expect(hazelcastConfigFromEnv({})).toMatchObject({
      enabled: false,
      mapName: 'default',
      client: { clusterName: 'dev', network: { clusterMembers: ['127.0.0.1:5701'] } },
    });
  });
});
