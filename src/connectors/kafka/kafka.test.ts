import logger from '#core/logger';
import { getRequestContext, runWithContext } from '#core/request-context';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KafkaConfig, KafkaConnector, kafkaConfigFromEnv } from './kafka';

// Fake of the Confluent client's KafkaJS-compatible API: records calls and captures the eachMessage callback
const fake = {
  kafkaConfig: undefined as any,
  consumerConfig: undefined as any,
  eachMessage: undefined as undefined | ((payload: any) => Promise<void>),
  calls: [] as string[],
  producer: {
    connect: vi.fn(async () => void fake.calls.push('producer.connect')),
    send: vi.fn(async (_record: any) => []),
    disconnect: vi.fn(async () => void fake.calls.push('producer.disconnect')),
  },
  consumer: {
    connect: vi.fn(async () => void fake.calls.push('consumer.connect')),
    subscribe: vi.fn(async (_subscription: any) => undefined),
    run: vi.fn(async ({ eachMessage }: any) => void (fake.eachMessage = eachMessage)),
    disconnect: vi.fn(async () => void fake.calls.push('consumer.disconnect')),
  },
};

/** Set when the mocked client library is first imported. */
const library = vi.hoisted(() => ({ loaded: false }));

vi.mock(
  '@confluentinc/kafka-javascript',
  () =>
    (library.loaded = true) && {
      KafkaJS: {
        Kafka: vi.fn(function (kafkaConfig: any) {
          fake.kafkaConfig = kafkaConfig;
          return {
            producer: () => fake.producer,
            consumer: (consumerConfig: any) => ((fake.consumerConfig = consumerConfig), fake.consumer),
          };
        }),
      },
    },
);

const baseConfig: KafkaConfig = {
  enabled: true,
  clientId: 'test-app',
  brokers: ['broker:9092'],
  groupId: 'test-group',
  fromBeginning: false,
  ssl: false,
  sasl: null,
  deadLetterSuffix: '.dlq',
};

/** Delivers a message the way the client's eachMessage callback would. */
function deliver(topic: string, value: string | null, extra: Record<string, any> = {}) {
  return fake.eachMessage!({
    topic,
    partition: 1,
    message: { key: Buffer.from('k1'), value: value === null ? null : Buffer.from(value), offset: '42', headers: {} },
    heartbeat: async () => undefined,
    pause: () => () => undefined,
    ...extra,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.calls = [];
  fake.eachMessage = undefined;
  fake.kafkaConfig = fake.consumerConfig = undefined;
});

describe('KafkaConnector', () => {
  // Must run first: the library is imported once per test file
  it('does not load the client library until init', async () => {
    const connector = new KafkaConnector(baseConfig);
    expect(library.loaded).toBe(false);

    await connector.init();

    expect(library.loaded).toBe(true);
    await connector.close();
  });

  it('reports enabled from config and is not ready before init', () => {
    const kafka = new KafkaConnector({ ...baseConfig, enabled: false });

    expect(kafka.enabled).toBe(false);
    expect(kafka.isReady()).toBe(false);
  });

  it('connects only a producer when no handler is registered', async () => {
    const kafka = new KafkaConnector(baseConfig);

    await kafka.init();

    expect(kafka.isReady()).toBe(true);
    expect(fake.kafkaConfig.kafkaJS).toMatchObject({ clientId: 'test-app', brokers: ['broker:9092'], ssl: false });
    expect(fake.kafkaConfig.kafkaJS).not.toHaveProperty('sasl');
    expect(fake.calls).toEqual(['producer.connect']);
  });

  it("routes the client's own logs through the application logger", async () => {
    const warn = vi.spyOn(logger, 'warn');
    const kafka = new KafkaConnector(baseConfig);
    await kafka.init();

    fake.kafkaConfig.kafkaJS.logger.namespace('producer').warn('broker down', { broker: 'b1' });

    expect(warn).toHaveBeenCalledWith({ info: 'Kafka client: broker down', broker: 'b1' });
    warn.mockRestore();
  });

  it('passes TLS and SASL settings to the client', async () => {
    const sasl = { mechanism: 'scram-sha-512' as const, username: 'user', password: 'pass' };
    const kafka = new KafkaConnector({ ...baseConfig, ssl: true, sasl });

    await kafka.init();

    expect(fake.kafkaConfig.kafkaJS).toMatchObject({ ssl: true, sasl });
  });

  it('starts a consumer for the registered topics', async () => {
    const kafka = new KafkaConnector({ ...baseConfig, fromBeginning: true });
    kafka.subscribe('orders', vi.fn());
    kafka.subscribe('payments', vi.fn());

    await kafka.init();

    expect(fake.consumerConfig).toEqual({ kafkaJS: { groupId: 'test-group', fromBeginning: true } });
    expect(fake.consumer.subscribe).toHaveBeenCalledWith({ topics: ['orders', 'payments'] });
    expect(fake.consumer.run).toHaveBeenCalled();
  });

  it('routes each message to its topic handler, decoded', async () => {
    const orders = vi.fn(async () => undefined);
    const payments = vi.fn(async () => undefined);
    const kafka = new KafkaConnector(baseConfig);
    kafka.subscribe('orders', orders);
    kafka.subscribe('payments', payments);
    await kafka.init();

    await deliver('orders', '{"id":1}', {
      message: { key: null, value: Buffer.from('{"id":1}'), offset: '7', headers: { trace: Buffer.from('abc') } },
    });

    expect(orders).toHaveBeenCalledWith({
      topic: 'orders',
      partition: 1,
      offset: '7',
      key: null,
      value: '{"id":1}',
      headers: { trace: 'abc' },
    });
    expect(payments).not.toHaveBeenCalled();
  });

  it('rejects handlers registered after init or twice for the same topic', async () => {
    const kafka = new KafkaConnector(baseConfig);
    kafka.subscribe('orders', vi.fn());

    expect(() => kafka.subscribe('orders', vi.fn())).toThrow('already registered');
    await kafka.init();
    expect(() => kafka.subscribe('payments', vi.fn())).toThrow('before the connector is initialised');
  });

  it('sends single messages and batches', async () => {
    const kafka = new KafkaConnector(baseConfig);
    await kafka.init();

    await kafka.send('orders', { key: 'a', value: '1' });
    await kafka.send('orders', [{ value: '2' }, { value: '3' }]);

    expect(fake.producer.send).toHaveBeenNthCalledWith(1, {
      topic: 'orders',
      messages: [{ key: 'a', value: '1', headers: {} }],
    });
    expect(fake.producer.send).toHaveBeenNthCalledWith(2, {
      topic: 'orders',
      messages: [
        { value: '2', headers: {} },
        { value: '3', headers: {} },
      ],
    });
  });

  it('adds the current request context to sent messages, without overriding their own headers', async () => {
    const kafka = new KafkaConnector(baseConfig);
    await kafka.init();
    const context = { requestId: 'req-1', traceId: 'a'.repeat(32) };

    await runWithContext(context, () =>
      kafka.send('orders', [{ value: '1' }, { value: '2', headers: { 'x-request-id': 'own-id' } }]),
    );

    const [first, second] = fake.producer.send.mock.calls[0][0].messages;
    expect(first.headers['x-request-id']).toBe('req-1');
    expect(first.headers.traceparent).toMatch(new RegExp(`^00-${'a'.repeat(32)}-[\\da-f]{16}-01$`));
    expect(second.headers['x-request-id']).toBe('own-id');
  });

  it('runs handlers in a request context rebuilt from the message headers', async () => {
    let seen: ReturnType<typeof getRequestContext>;
    const kafka = new KafkaConnector(baseConfig);
    kafka.subscribe('orders', async () => {
      await Promise.resolve();
      seen = getRequestContext();
    });
    await kafka.init();

    await deliver('orders', '{}', {
      message: {
        key: null,
        value: Buffer.from('{}'),
        offset: '1',
        headers: {
          'x-request-id': Buffer.from('from-producer'),
          traceparent: `00-${'b'.repeat(32)}-${'c'.repeat(16)}-01`,
        },
      },
    });

    expect(seen).toEqual({ requestId: 'from-producer', traceId: 'b'.repeat(32) });
  });

  it('refuses to send before init and after close', async () => {
    const kafka = new KafkaConnector(baseConfig);
    await expect(kafka.send('orders', { value: 'x' })).rejects.toThrow('not ready');

    await kafka.init();
    await kafka.close();

    await expect(kafka.send('orders', { value: 'x' })).rejects.toThrow('not ready');
  });

  it('propagates broker errors to the caller', async () => {
    const kafka = new KafkaConnector(baseConfig);
    await kafka.init();
    fake.producer.send.mockRejectedValueOnce(new Error('broker down'));

    await expect(kafka.send('orders', { value: 'x' })).rejects.toThrow('broker down');
  });

  it('publishes a failed message to the dead-letter topic and keeps consuming', async () => {
    const kafka = new KafkaConnector(baseConfig);
    kafka.subscribe('orders', async () => {
      throw new Error('bad order');
    });
    await kafka.init();

    await expect(deliver('orders', '{"card":"4111"}')).resolves.toBeUndefined();

    expect(fake.producer.send).toHaveBeenCalledWith({
      topic: 'orders.dlq',
      messages: [
        {
          key: Buffer.from('k1'),
          value: Buffer.from('{"card":"4111"}'),
          headers: {
            'x-error': 'bad order',
            'x-original-topic': 'orders',
            'x-original-partition': '1',
            'x-original-offset': '42',
          },
        },
      ],
    });
  });

  it('rethrows handler errors when the dead-letter topic is disabled, so the message is retried', async () => {
    const kafka = new KafkaConnector({ ...baseConfig, deadLetterSuffix: '' });
    kafka.subscribe('orders', async () => {
      throw new Error('bad order');
    });
    await kafka.init();

    await expect(deliver('orders', '{}')).rejects.toThrow('bad order');
    expect(fake.producer.send).not.toHaveBeenCalled();
  });

  it('does not log message values', async () => {
    const error = vi.spyOn(logger, 'error');
    const kafka = new KafkaConnector(baseConfig);
    kafka.subscribe('orders', async () => {
      throw new Error('bad order');
    });
    await kafka.init();

    await deliver('orders', '{"card":"4111-1111"}');

    expect(JSON.stringify(error.mock.calls)).not.toContain('4111-1111');
    error.mockRestore();
  });

  it('disconnects the consumer before the producer on close', async () => {
    const kafka = new KafkaConnector(baseConfig);
    kafka.subscribe('orders', vi.fn());
    await kafka.init();

    await kafka.close();

    expect(kafka.isReady()).toBe(false);
    expect(fake.calls.slice(-2)).toEqual(['consumer.disconnect', 'producer.disconnect']);
  });
});

describe('kafkaConfigFromEnv', () => {
  it('has defaults based on APP_NAME', () => {
    expect(kafkaConfigFromEnv({})).toEqual({
      enabled: false,
      clientId: 'modular-express-ts',
      brokers: ['localhost:9092'],
      groupId: 'modular-express-ts-group',
      fromBeginning: false,
      ssl: false,
      sasl: null,
      deadLetterSuffix: '.dlq',
    });
  });

  it('reads brokers, TLS and SASL', () => {
    const config = kafkaConfigFromEnv({
      KAFKA_ENABLED: 'true',
      KAFKA_BROKERS: 'b1:9092, b2:9092',
      KAFKA_SSL: 'true',
      KAFKA_SASL_MECHANISM: 'scram-sha-512',
      KAFKA_SASL_USERNAME: 'user',
      KAFKA_SASL_PASSWORD: 'pass',
      KAFKA_DEAD_LETTER_SUFFIX: '',
    });

    expect(config).toMatchObject({
      enabled: true,
      brokers: ['b1:9092', 'b2:9092'],
      ssl: true,
      sasl: { mechanism: 'scram-sha-512', username: 'user', password: 'pass' },
      deadLetterSuffix: '',
    });
  });

  it('requires credentials when a SASL mechanism is set, and rejects unknown mechanisms', () => {
    expect(() => kafkaConfigFromEnv({ KAFKA_SASL_MECHANISM: 'plain' })).toThrow('KAFKA_SASL_USERNAME');
    expect(() => kafkaConfigFromEnv({ KAFKA_SASL_MECHANISM: 'kerberos' })).toThrow('KAFKA_SASL_MECHANISM');
  });
});
