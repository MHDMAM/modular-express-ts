import { createServer, type AddressInfo } from 'node:net';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hazelcastConfigFromEnv, HazelcastConnector } from '#connectors/hazelcast/hazelcast';

// The connector against a real Hazelcast member (Docker required): `npm run test:integration`

const IMAGE = 'hazelcast/hazelcast:5.5';

let port: number;
let container: StartedTestContainer;
let hazelcast: HazelcastConnector;

/**
 * The member tells its clients which address to use: it must be the published one, so the host port is chosen before
 * the container starts.
 */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port: free } = server.address() as AddressInfo;
      server.close(() => resolve(free));
    });
  });
}

function startMember(): Promise<StartedTestContainer> {
  return new GenericContainer(IMAGE)
    .withExposedPorts({ container: 5701, host: port })
    .withEnvironment({ JAVA_OPTS: `-Dhazelcast.local.publicAddress=127.0.0.1:${port}`, HZ_CLUSTERNAME: 'integration' })
    .withWaitStrategy(Wait.forLogMessage(/is STARTED/))
    .start();
}

/** A connector configured like the application: from the environment variables. */
function connector(env: Record<string, string> = {}): HazelcastConnector {
  return new HazelcastConnector(
    hazelcastConfigFromEnv({
      HAZELCAST_ENABLED: 'true',
      HAZELCAST_CLUSTER_NAME: 'integration',
      HAZELCAST_MEMBERS: `127.0.0.1:${port}`,
      HAZELCAST_MAP_NAME: 'cache',
      ...env,
    }),
  );
}

/** Resolves with the outcome of `promise`, or `'pending'` when it has not settled after `ms`. */
const settledWithin = (promise: Promise<unknown>, ms: number) =>
  Promise.race([
    promise.then(
      () => 'resolved',
      () => 'rejected',
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('pending'), ms)),
  ]);

beforeAll(async () => {
  port = await freePort();
  container = await startMember();
  hazelcast = connector();
  await hazelcast.init();
});

afterAll(async () => {
  await hazelcast?.close();
  await container?.stop();
});

describe('cache', () => {
  it('is ready once connected', () => {
    expect(hazelcast.isReady()).toBe(true);
  });

  it.each([
    ['an object', { id: 1, name: 'Ada', tags: ['a', 'b'], nested: { ok: true, none: null } }],
    ['a string', 'plain'],
    ['unicode', '日本語 · é · 😀'],
    ['a number', 12.5],
    ['zero', 0],
    ['false', false],
    ['null', null],
    ['an empty string', ''],
    // The client's own serialization would return [1, null, null]
    ['an array of mixed types', [1, 'two', { three: 3 }]],
  ])('round-trips %s', async (_label, value) => {
    await hazelcast.set('value', value);

    expect(await hazelcast.get('value')).toEqual(value);
  });

  it('round-trips a large value', async () => {
    const value = { text: 'x'.repeat(1_000_000) };

    await hazelcast.set('large', value);

    expect(await hazelcast.get('large')).toEqual(value);
  });

  it('returns undefined for a missing key, and deletes keys', async () => {
    await hazelcast.set('gone', 1);

    await hazelcast.delete('gone');
    await hazelcast.delete('never-there');

    expect(await hazelcast.get('gone')).toBeUndefined();
    expect(await hazelcast.get('never-there')).toBeUndefined();
  });

  // Hazelcast expires entries with a resolution of about a second, so the TTLs here are a few seconds
  it('expires a key after its TTL, and keeps one without TTL', async () => {
    await hazelcast.set('short', 1, 3_000);
    await hazelcast.set('fraction', 1, 2_000.5);
    await hazelcast.set('kept', 1);
    await hazelcast.set('untouched', 1, 0);

    expect(await hazelcast.get('short')).toBe(1);
    await expect.poll(() => hazelcast.get('short'), { timeout: 8_000 }).toBeUndefined();
    await expect.poll(() => hazelcast.get('fraction'), { timeout: 8_000 }).toBeUndefined();
    expect(await hazelcast.get('kept')).toBe(1);
    expect(await hazelcast.get('untouched')).toBe(1);
  });

  it('keeps maps apart, and exposes them for other operations', async () => {
    const sessions = await hazelcast.map<{ user: string }>('sessions');
    await sessions.set('s1', { user: 'ada' });
    await hazelcast.set('s1', 'in the default map');

    expect(await sessions.get('s1')).toEqual({ user: 'ada' });
    expect(await hazelcast.get('s1')).toBe('in the default map');
    expect(await sessions.size()).toBe(1);
    expect(await sessions.containsKey('s1')).toBe(true);
    await sessions.clear();
  });

  it('stores JSON text, and reports a value written otherwise', async () => {
    const map = await hazelcast.map<unknown>('cache');
    await hazelcast.set('json', { a: 1 });
    expect(await map.get('json')).toBe('{"a":1}');

    await map.set('native', { a: 1 });
    await expect(hazelcast.get('native')).rejects.toThrow('the value of "native" is not JSON');
  });

  it('shares the map with another client', async () => {
    const other = connector();
    await other.init();

    await hazelcast.set('shared', { from: 'first' });

    expect(await other.get('shared')).toEqual({ from: 'first' });
    await other.close();
  });
});

describe('lifecycle', () => {
  it('can be closed and initialised again', async () => {
    const again = connector();
    await again.init();
    await again.close();
    expect(again.isReady()).toBe(false);
    await expect(again.get('value')).rejects.toThrow('not ready');

    await again.init();
    expect(again.isReady()).toBe(true);
    await again.close();
  });

  it('keeps trying to reach a cluster that is not there until closed', async () => {
    const nowhere = connector({ HAZELCAST_MEMBERS: '127.0.0.1:1' });

    const initializing = nowhere.init();
    expect(await settledWithin(initializing, 3_000)).toBe('pending');
    expect(nowhere.isReady()).toBe(false);

    expect(await settledWithin(nowhere.close(), 5_000)).toBe('resolved');
    expect(await settledWithin(initializing, 2_000)).toBe('rejected');
  });

  it('does not join a cluster with another name', async () => {
    const stranger = connector({ HAZELCAST_CLUSTER_NAME: 'another-cluster' });

    const initializing = stranger.init();
    expect(await settledWithin(initializing, 3_000)).toBe('pending');
    await stranger.close();
    expect(await settledWithin(initializing, 2_000)).toBe('rejected');
  });
});

// Last: it stops the member
describe('member loss', () => {
  it('fails at once while the member is away, and works again when it is back, however long that takes', async () => {
    await hazelcast.set('before', 1);
    await container.stop();

    await expect.poll(() => hazelcast.isReady(), { timeout: 20_000 }).toBe(false);
    expect(await settledWithin(hazelcast.get('before'), 2_000)).toBe('rejected');
    expect(await settledWithin(hazelcast.set('during', 1), 2_000)).toBe('rejected');

    // Longer than the 20 seconds after which the client used to shut itself down for good
    await new Promise((resolve) => setTimeout(resolve, 25_000));
    container = await startMember();

    await expect.poll(() => hazelcast.isReady(), { timeout: 60_000 }).toBe(true);
    await hazelcast.set('after', 2);
    expect(await hazelcast.get('after')).toBe(2);
    // The member lost its memory with the restart
    expect(await hazelcast.get('before')).toBeUndefined();
  }, 180_000);
});
