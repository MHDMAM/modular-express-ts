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

vi.mock(
  'hazelcast-client',
  async (importOriginal) =>
    (library.loaded = true) && {
      ...(await importOriginal<object>()),
      Client: {
        newHazelcastClient: vi.fn(async (clientConfig: any) => {
          fake.clientConfig = clientConfig;
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
    expect(fake.maps.get('cache')!.ttls.get('user:1')).toBe(60_000);
    expect(fake.maps.get('cache')!.ttls.get('user:2')).toBe(0);

    await hazelcast.delete('user:1');
    expect(await hazelcast.get('user:1')).toBeUndefined();
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
      HAZELCAST_CONNECT_TIMEOUT_MS: '5000',
    });

    expect(config).toMatchObject({
      enabled: true,
      mapName: 'sessions',
      client: {
        clusterName: 'prod',
        network: { clusterMembers: ['hz1:5701', 'hz2:5701'] },
        connectionStrategy: { connectionRetry: { clusterConnectTimeoutMillis: 5000 } },
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
