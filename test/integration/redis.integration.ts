import { RedisContainer } from '@testcontainers/redis';
import { ValkeyContainer } from '@testcontainers/valkey';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RedisConnector } from '#connectors/redis/redis';

// The connector against a real Redis and a real Valkey (Docker required): `npm run test:integration`

const servers = [
  { name: 'Redis', start: () => new RedisContainer('redis:8').start() },
  { name: 'Valkey', start: () => new ValkeyContainer('valkey/valkey:8').start() },
];

/** Resolves with the outcome of `promise`, or `'pending'` when it has not settled after `ms`. */
const settledWithin = (promise: Promise<unknown>, ms: number) =>
  Promise.race([
    promise.then(
      () => 'resolved',
      () => 'rejected',
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('pending'), ms)),
  ]);

describe.each(servers)('$name', ({ start }) => {
  let container: Awaited<ReturnType<typeof start>>;
  let redis: RedisConnector;

  beforeAll(async () => {
    container = await start();
    redis = new RedisConnector({ enabled: true, url: container.getConnectionUrl(), keyPrefix: 'app:' });
    await redis.init();
  });

  afterAll(async () => {
    await redis?.close();
    await container?.stop();
  });

  it('is ready once connected', () => {
    expect(redis.isReady()).toBe(true);
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
    ['an array', [1, 'two', { three: 3 }]],
  ])('round-trips %s', async (_label, value) => {
    await redis.set('value', value);

    expect(await redis.get('value')).toEqual(value);
  });

  it('round-trips a large value', async () => {
    const value = { text: 'x'.repeat(1_000_000) };

    await redis.set('large', value);

    expect(await redis.get('large')).toEqual(value);
  });

  it('stores under the key prefix, apart from another prefix', async () => {
    const other = new RedisConnector({ enabled: true, url: container.getConnectionUrl(), keyPrefix: 'other:' });
    await other.init();

    await redis.set('shared', 'mine');
    await other.set('shared', 'theirs');

    expect(await redis.get('shared')).toBe('mine');
    expect(await other.get('shared')).toBe('theirs');
    expect(await redis.raw.get('app:shared')).toBe('"mine"');
    await other.close();
  });

  it('returns undefined for a missing key, and deletes keys', async () => {
    await redis.set('gone', 1);

    await redis.delete('gone');
    await redis.delete('never-there');

    expect(await redis.get('gone')).toBeUndefined();
    expect(await redis.get('never-there')).toBeUndefined();
  });

  it('expires a key after its TTL, and keeps one without TTL', async () => {
    await redis.set('short', 1, 150);
    await redis.set('kept', 1);
    await redis.set('untouched', 1, 0);

    expect(await redis.raw.pTTL('app:short')).toBeGreaterThan(0);
    expect(await redis.raw.pTTL('app:kept')).toBe(-1);
    expect(await redis.raw.pTTL('app:untouched')).toBe(-1);
    await expect.poll(() => redis.get('short'), { timeout: 2_000 }).toBeUndefined();
    expect(await redis.get('kept')).toBe(1);
  });

  it('accepts a TTL with a fraction of a millisecond', async () => {
    await redis.set('fraction', 1, 1500.5);

    const ttl = await redis.raw.pTTL('app:fraction');
    expect(ttl).toBeGreaterThan(1000);
    expect(ttl).toBeLessThanOrEqual(1501);
  });

  it('replaces the TTL when a key is set again without one', async () => {
    await redis.set('renewed', 1, 60_000);
    await redis.set('renewed', 2);

    expect(await redis.raw.pTTL('app:renewed')).toBe(-1);
  });

  it('runs other commands through the raw client, and reports a value that is not JSON', async () => {
    await redis.raw.del('app:visits');
    await redis.raw.incr('app:visits');
    expect(await redis.raw.incr('app:visits')).toBe(2);
    expect(await redis.get('visits')).toBe(2);

    await redis.raw.set('app:text', 'not json');
    await expect(redis.get('text')).rejects.toThrow('the value of "text" is not JSON');
  });

  it('can be closed and initialised again', async () => {
    const again = new RedisConnector({ enabled: true, url: container.getConnectionUrl(), keyPrefix: 'app:' });
    await again.init();
    await again.close();
    expect(again.isReady()).toBe(false);
    await expect(again.get('value')).rejects.toThrow('not ready');

    await again.init();
    expect(again.isReady()).toBe(true);
    await again.close();
  });

  // Last: it stops the server
  it('stops being ready and fails commands at once when the server goes away', async () => {
    await container.stop();

    await expect.poll(() => redis.isReady(), { timeout: 10_000 }).toBe(false);
    expect(await settledWithin(redis.get('value'), 2_000)).toBe('rejected');
    expect(await settledWithin(redis.set('value', 1), 2_000)).toBe('rejected');
    expect(await settledWithin(redis.close(), 2_000)).toBe('resolved');
  });
});

describe('a server that is not there', () => {
  it('keeps trying to connect until closed', async () => {
    const redis = new RedisConnector({ enabled: true, url: 'redis://127.0.0.1:1', keyPrefix: '' });

    const initializing = redis.init();
    expect(await settledWithin(initializing, 1_500)).toBe('pending');
    expect(redis.isReady()).toBe(false);

    await redis.close();
    expect(await settledWithin(initializing, 2_000)).toBe('rejected');
  });
});
