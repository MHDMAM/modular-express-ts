import { KafkaConfig, KafkaConnector } from '@libs/Kafka';
import logger from '@utils/logger';

// Fake of the Confluent client's KafkaJS-compatible API: records calls and captures the eachMessage callback
const fake = {
  kafkaConfig: undefined as any,
  consumerConfig: undefined as any,
  eachMessage: undefined as undefined | ((payload: any) => Promise<void>),
  calls: [] as string[],
  producer: {
    connect: jest.fn(async () => void fake.calls.push('producer.connect')),
    send: jest.fn(async (_record: any) => []),
    disconnect: jest.fn(async () => void fake.calls.push('producer.disconnect')),
  },
  consumer: {
    connect: jest.fn(async () => void fake.calls.push('consumer.connect')),
    subscribe: jest.fn(async (_subscription: any) => undefined),
    run: jest.fn(async ({ eachMessage }: any) => void (fake.eachMessage = eachMessage)),
    disconnect: jest.fn(async () => void fake.calls.push('consumer.disconnect')),
  },
};

jest.mock('@confluentinc/kafka-javascript', () => ({
  KafkaJS: {
    Kafka: jest.fn().mockImplementation((kafkaConfig) => {
      fake.kafkaConfig = kafkaConfig;
      return {
        producer: () => fake.producer,
        consumer: (consumerConfig: any) => ((fake.consumerConfig = consumerConfig), fake.consumer),
      };
    }),
  },
}));

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
  jest.clearAllMocks();
  fake.calls = [];
  fake.eachMessage = undefined;
  fake.kafkaConfig = fake.consumerConfig = undefined;
});

describe('KafkaConnector', () => {
  it('reports enabled from config and is not ready before init', () => {
    const kafka = new KafkaConnector({ ...baseConfig, enabled: false });

    expect(kafka.enabled).toBe(false);
    expect(kafka.isReady()).toBe(false);
  });

  it('connects only a producer when no handler is registered', async () => {
    const kafka = new KafkaConnector(baseConfig);

    await kafka.init();

    expect(kafka.isReady()).toBe(true);
    expect(fake.kafkaConfig).toEqual({ kafkaJS: { clientId: 'test-app', brokers: ['broker:9092'], ssl: false } });
    expect(fake.calls).toEqual(['producer.connect']);
  });

  it('passes TLS and SASL settings to the client', async () => {
    const sasl = { mechanism: 'scram-sha-512' as const, username: 'user', password: 'pass' };
    const kafka = new KafkaConnector({ ...baseConfig, ssl: true, sasl });

    await kafka.init();

    expect(fake.kafkaConfig.kafkaJS).toMatchObject({ ssl: true, sasl });
  });

  it('starts a consumer for the registered topics', async () => {
    const kafka = new KafkaConnector({ ...baseConfig, fromBeginning: true });
    kafka.subscribe('orders', jest.fn());
    kafka.subscribe('payments', jest.fn());

    await kafka.init();

    expect(fake.consumerConfig).toEqual({ kafkaJS: { groupId: 'test-group', fromBeginning: true } });
    expect(fake.consumer.subscribe).toHaveBeenCalledWith({ topics: ['orders', 'payments'] });
    expect(fake.consumer.run).toHaveBeenCalled();
  });

  it('routes each message to its topic handler, decoded', async () => {
    const orders = jest.fn(async () => undefined);
    const payments = jest.fn(async () => undefined);
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
    kafka.subscribe('orders', jest.fn());

    expect(() => kafka.subscribe('orders', jest.fn())).toThrow('already registered');
    await kafka.init();
    expect(() => kafka.subscribe('payments', jest.fn())).toThrow('before the connector is initialised');
  });

  it('sends single messages and batches', async () => {
    const kafka = new KafkaConnector(baseConfig);
    await kafka.init();

    await kafka.send('orders', { key: 'a', value: '1' });
    await kafka.send('orders', [{ value: '2' }, { value: '3' }]);

    expect(fake.producer.send).toHaveBeenNthCalledWith(1, { topic: 'orders', messages: [{ key: 'a', value: '1' }] });
    expect(fake.producer.send).toHaveBeenNthCalledWith(2, {
      topic: 'orders',
      messages: [{ value: '2' }, { value: '3' }],
    });
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
    const error = jest.spyOn(logger, 'error');
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
    kafka.subscribe('orders', jest.fn());
    await kafka.init();

    await kafka.close();

    expect(kafka.isReady()).toBe(false);
    expect(fake.calls.slice(-2)).toEqual(['consumer.disconnect', 'producer.disconnect']);
  });
});
