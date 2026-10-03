import { randomUUID } from 'node:crypto';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { KafkaContainer, type StartedKafkaContainer } from '@testcontainers/kafka';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { KafkaConnector, type IncomingMessage, type KafkaConfig } from '#connectors/kafka/kafka';
import { getRequestContext, runWithContext } from '#core/request-context';

// The connector against a real Kafka broker (Docker required): `npm run test:integration`

const IMAGE = 'confluentinc/cp-kafka:7.9.1';

let container: StartedKafkaContainer;
let brokers: string[];
let admin: KafkaJS.Admin;
const connectors: KafkaConnector[] = [];

/** A connector for this broker, closed after the test. Each gets its own consumer group unless one is given. */
function connector(overrides: Partial<KafkaConfig> = {}): KafkaConnector {
  const kafka = new KafkaConnector({
    enabled: true,
    clientId: 'integration',
    brokers,
    groupId: `group-${randomUUID()}`,
    fromBeginning: true,
    ssl: false,
    sasl: null,
    deadLetterSuffix: '.dlq',
    sendTimeoutMs: 10_000,
    healthCheckIntervalMs: 0,
    // The broker's port is published on IPv4 only
    addressFamily: 'v4',
    ...overrides,
  });
  connectors.push(kafka);
  return kafka;
}

/** Creates the topics (a consumer does not create the topics it subscribes to) and returns their names. */
async function topics(...names: string[]): Promise<string[]> {
  const unique = names.map((name) => `${name}-${randomUUID()}`);
  await admin.createTopics({ topics: unique.map((topic) => ({ topic, numPartitions: 1 })) });
  return unique;
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
  container = await new KafkaContainer(IMAGE).withKraft().start();
  brokers = [`${container.getHost()}:${container.getMappedPort(9093)}`];
  const silent: KafkaJS.Logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    namespace: () => silent,
    setLogLevel: () => undefined,
  };
  admin = new KafkaJS.Kafka({ kafkaJS: { brokers, logger: silent }, 'broker.address.family': 'v4' }).admin();
  await admin.connect();
  // The container is reported started a little before the broker takes requests
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await admin.listTopics({ timeout: 2_000 }).catch(() => undefined)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('The Kafka broker did not become ready');
});

afterEach(async () => {
  await Promise.all(connectors.splice(0).map((kafka) => kafka.close()));
});

afterAll(async () => {
  await admin?.disconnect();
  await container?.stop();
});

describe('producing and consuming', () => {
  it('delivers a message to the handler of its topic, decoded', async () => {
    const [orders, payments] = await topics('orders', 'payments');
    const received: IncomingMessage[] = [];
    const kafka = connector();
    kafka.subscribe(orders, async (message) => void received.push(message));
    kafka.subscribe(payments, async (message) => void received.push(message));
    await kafka.init();
    expect(kafka.isReady()).toBe(true);

    await kafka.send(orders, { key: 'order-1', value: '{"total":12.5}', headers: { source: 'test' } });
    await kafka.send(payments, { key: 'payment-1', value: 'paid' });

    await expect.poll(() => received.length, { timeout: 30_000 }).toBe(2);
    const order = received.find((message) => message.topic === orders)!;
    expect(order).toMatchObject({ partition: 0, offset: '0', key: 'order-1', value: '{"total":12.5}' });
    expect(order.headers).toEqual({ source: 'test' });
    expect(received.find((message) => message.topic === payments)).toMatchObject({ key: 'payment-1', value: 'paid' });
  });

  it('keeps the order of a batch, and handles null keys, tombstones, buffers and unicode', async () => {
    const [topic] = await topics('events');
    const received: IncomingMessage[] = [];
    const kafka = connector();
    kafka.subscribe(topic, async (message) => void received.push(message));
    await kafka.init();

    await kafka.send(
      topic,
      Array.from({ length: 50 }, (_, index) => ({ key: 'same', value: String(index) })),
    );
    await kafka.send(topic, [
      { value: 'no key' },
      { key: 'deleted', value: null },
      { key: 'binary', value: Buffer.from('from a buffer') },
      { key: 'unicode', value: '日本語 · é · 😀', headers: { note: 'ünïcödé' } },
      { key: 'large', value: 'x'.repeat(500_000) },
    ]);

    await expect.poll(() => received.length, { timeout: 30_000 }).toBe(55);
    expect(received.slice(0, 50).map((message) => message.value)).toEqual(Array.from({ length: 50 }, (_, i) => `${i}`));
    expect(received.slice(50).map(({ key, value }) => [key, value?.length === 500_000 ? 'large' : value])).toEqual([
      [null, 'no key'],
      ['deleted', null],
      ['binary', 'from a buffer'],
      ['unicode', '日本語 · é · 😀'],
      ['large', 'large'],
    ]);
    expect(received[53].headers).toEqual({ note: 'ünïcödé' });
  });

  it('carries the request context from the sender to the handler', async () => {
    const [topic] = await topics('traced');
    const seen: unknown[] = [];
    const kafka = connector();
    kafka.subscribe(topic, async (message) => void seen.push([getRequestContext(), message.headers]));
    await kafka.init();
    const context = { requestId: 'req-42', traceId: 'a'.repeat(32) };

    await runWithContext(context, () => kafka.send(topic, { value: 'x' }));

    await expect.poll(() => seen.length, { timeout: 30_000 }).toBe(1);
    const [handlerContext, headers] = seen[0] as [unknown, Record<string, string>];
    expect(handlerContext).toMatchObject(context);
    expect(headers['x-request-id']).toBe('req-42');
    expect(headers.traceparent).toMatch(new RegExp(`^00-${'a'.repeat(32)}-[0-9a-f]{16}-01$`));
  });

  it('sends to a topic that does not exist yet', async () => {
    const kafka = connector();
    await kafka.init();

    await expect(kafka.send(`created-on-send-${randomUUID()}`, { value: 'x' })).resolves.toBeUndefined();
  });
});

describe('failing handlers', () => {
  it('moves a failed message to the dead-letter topic and keeps consuming', async () => {
    const [topic] = await topics('risky');
    const [deadLetters] = [`${topic}.dlq`];
    await admin.createTopics({ topics: [{ topic: deadLetters, numPartitions: 1 }] });
    const handled: string[] = [];
    const dead: IncomingMessage[] = [];
    const kafka = connector();
    kafka.subscribe(topic, async (message) => {
      if (message.value === 'bad') throw new Error('cannot process');
      handled.push(message.value!);
    });
    kafka.subscribe(deadLetters, async (message) => void dead.push(message));
    await kafka.init();

    await kafka.send(topic, [
      { key: 'k1', value: 'good' },
      { key: 'k2', value: 'bad', headers: { source: 'test' } },
      { key: 'k3', value: 'also good' },
    ]);

    await expect.poll(() => [handled.length, dead.length], { timeout: 30_000 }).toEqual([2, 1]);
    expect(handled).toEqual(['good', 'also good']);
    expect(dead[0]).toMatchObject({ key: 'k2', value: 'bad' });
    expect(dead[0].headers).toEqual({
      source: 'test',
      'x-error': 'cannot process',
      'x-original-topic': topic,
      'x-original-partition': '0',
      'x-original-offset': '1',
    });
  });

  it('delivers the message again when the dead-letter topic is disabled', async () => {
    const [topic] = await topics('retried');
    const attempts: string[] = [];
    const kafka = connector({ deadLetterSuffix: '' });
    kafka.subscribe(topic, async (message) => {
      attempts.push(message.value!);
      if (attempts.length < 3) throw new Error('not yet');
    });
    await kafka.init();

    await kafka.send(topic, [{ value: 'first' }, { value: 'second' }]);

    await expect.poll(() => attempts, { timeout: 60_000 }).toEqual(['first', 'first', 'first', 'second']);
  });
});

describe('consumer groups', () => {
  it('resumes after the last handled message when the same group comes back', async () => {
    const [topic] = await topics('resumed');
    const groupId = `group-${randomUUID()}`;
    const first: string[] = [];
    const before = connector({ groupId });
    before.subscribe(topic, async (message) => void first.push(message.value!));
    await before.init();
    await before.send(topic, [{ value: '1' }, { value: '2' }, { value: '3' }]);
    await expect.poll(() => first, { timeout: 30_000 }).toEqual(['1', '2', '3']);
    await before.close();

    const second: string[] = [];
    const after = connector({ groupId });
    after.subscribe(topic, async (message) => void second.push(message.value!));
    await after.init();
    await after.send(topic, [{ value: '4' }, { value: '5' }]);

    await expect.poll(() => second, { timeout: 30_000 }).toEqual(['4', '5']);
  });

  it('gives each group every message', async () => {
    const [topic] = await topics('fanout');
    const received: Record<string, string[]> = { a: [], b: [] };
    const a = connector();
    const b = connector();
    a.subscribe(topic, async (message) => void received.a.push(message.value!));
    b.subscribe(topic, async (message) => void received.b.push(message.value!));
    await Promise.all([a.init(), b.init()]);

    await a.send(topic, [{ value: '1' }, { value: '2' }]);

    await expect.poll(() => received, { timeout: 30_000 }).toEqual({ a: ['1', '2'], b: ['1', '2'] });
  });
});

describe('lifecycle', () => {
  it('can be closed and initialised again', async () => {
    const [topic] = await topics('again');
    const received: string[] = [];
    const kafka = connector();
    kafka.subscribe(topic, async (message) => void received.push(message.value!));
    await kafka.init();
    await kafka.close();
    expect(kafka.isReady()).toBe(false);
    await expect(kafka.send(topic, { value: 'x' })).rejects.toThrow('not ready');

    await kafka.init();
    await kafka.send(topic, { value: 'after' });

    await expect.poll(() => received, { timeout: 30_000 }).toEqual(['after']);
  });

  it('keeps trying to reach brokers that are not there until closed', async () => {
    const kafka = connector({ brokers: ['127.0.0.1:1'] });

    const initializing = kafka.init();
    expect(await settledWithin(initializing, 3_000)).toBe('pending');
    expect(kafka.isReady()).toBe(false);

    // Slow: the client's native teardown waits for its connection attempts
    await kafka.close();
    expect(await settledWithin(initializing, 5_000)).toBe('rejected');
  });
});

// Last: it stops the broker
describe('broker loss', () => {
  it('stops being ready, and fails a send after the send timeout', async () => {
    const [topic] = await topics('lost');
    const kafka = connector({ healthCheckIntervalMs: 500, sendTimeoutMs: 3_000 });
    await kafka.init();
    await kafka.send(topic, { value: 'while up' });
    expect(kafka.isReady()).toBe(true);

    await container.stop();

    await expect.poll(() => kafka.isReady(), { timeout: 30_000 }).toBe(false);
    const start = Date.now();
    await expect(kafka.send(topic, { value: 'while down' })).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(10_000);
  });
});
