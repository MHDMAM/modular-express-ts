import type { KafkaJS } from '@confluentinc/kafka-javascript';
import { z } from 'zod';

import config, { envBoolean, envList, envNumber, envOptional, envString, loadOrExit, parseEnv } from '#config';
import { HealthCheck } from '#core/health-check';
import type { Connector } from '#core/lifecycle';
import logger from '#core/logger';
import { contextFromHeaders, contextHeaders, runWithContext } from '#core/request-context';

export interface KafkaConfig {
  enabled: boolean;
  clientId: string;
  brokers: string[];
  /** Consumer group; only used when at least one topic handler is registered. */
  groupId: string;
  /** Start from the earliest offset when the group has no committed offset yet. */
  fromBeginning: boolean;
  ssl: boolean;
  /** Required by most managed Kafka services (Confluent Cloud, MSK, Aiven, ...). */
  sasl: { mechanism: 'plain' | 'scram-sha-256' | 'scram-sha-512'; username: string; password: string } | null;
  /**
   * When a handler throws, the message is published to `<topic><deadLetterSuffix>` and consumption continues.
   * Empty string disables it: the error is rethrown and the consumer retries the message.
   */
  deadLetterSuffix: string;
  /** How long `send()` waits for the broker to take a message before failing (the client's default is 5 minutes). */
  sendTimeoutMs: number;
  /** How often the brokers are asked for metadata for `isReady()`; 0 disables it. */
  healthCheckIntervalMs: number;
  /**
   * IP version used to reach the brokers. `v4` avoids a slow first connection where a name such as `localhost`
   * resolves to IPv6 first but the broker only listens on IPv4 (Docker on Windows).
   */
  addressFamily: 'any' | 'v4' | 'v6';
}

export interface IncomingMessage {
  topic: string;
  partition: number;
  offset: string;
  key: string | null;
  value: string | null;
  headers: Record<string, string>;
}

export interface OutgoingMessage {
  key?: string | null;
  value: string | Buffer | null;
  headers?: Record<string, string>;
}

export type MessageHandler = (message: IncomingMessage) => Promise<void>;

/** Routes the client's own log output through the application logger (it prints raw objects to the console otherwise). */
function clientLogger(): KafkaJS.Logger {
  const forward = (level: 'info' | 'warn' | 'error' | 'debug') => (message: string, extra?: object) =>
    logger[level]({ info: `Kafka client: ${message}`, ...extra });
  const adapter: KafkaJS.Logger = {
    info: forward('info'),
    warn: forward('warn'),
    error: forward('error'),
    debug: forward('debug'),
    namespace: () => adapter,
    setLogLevel: () => undefined,
  };
  return adapter;
}

function decodeHeaders(headers?: KafkaJS.IHeaders): Record<string, string> {
  const decoded: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value !== undefined) decoded[key] = Array.isArray(value) ? value.map(String).join(',') : value.toString();
  }
  return decoded;
}

/**
 * Kafka producer and (optional) consumer, using Confluent's official client through its KafkaJS-compatible API.
 *
 * ```ts
 * import kafka from '#connectors/kafka/kafka';
 * kafka.subscribe('orders', async (message) => { ... }); // at module load, before startup
 * await kafka.send('orders', { key: order.id, value: JSON.stringify(order) });
 * ```
 */
export class KafkaConnector implements Connector {
  readonly name = 'kafka';
  private kafka?: KafkaJS.Kafka;
  private producer?: KafkaJS.Producer;
  private consumer?: KafkaJS.Consumer;
  /** Only used by the health check. */
  private admin?: KafkaJS.Admin;
  private readonly handlers = new Map<string, MessageHandler>();
  private ready = false;
  /**
   * Asks the brokers for metadata: the client reconnects on its own and reports nothing when its brokers go away, so
   * without this the connector would look ready forever.
   */
  private readonly health = new HealthCheck(async (timeout) => void (await this.admin?.listTopics({ timeout })));
  /** Incremented by init() and close(), so an init() still connecting knows it was closed meanwhile. */
  private generation = 0;

  constructor(private readonly config: KafkaConfig) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Registers the handler for a topic. Must be called before startup; the consumer only runs if handlers exist. */
  subscribe(topic: string, handler: MessageHandler): void {
    if (this.kafka) throw new Error('Kafka: subscribe() must be called before the connector is initialised');
    if (this.handlers.has(topic)) throw new Error(`Kafka: a handler for topic "${topic}" is already registered`);
    this.handlers.set(topic, handler);
  }

  async init(): Promise<void> {
    const generation = ++this.generation;
    const closed = () => {
      if (generation !== this.generation) throw new Error('Kafka connector was closed during init');
    };
    const { clientId, brokers, ssl, sasl, groupId, fromBeginning, sendTimeoutMs, addressFamily } = this.config;
    // Loaded here, not at import time: a disabled connector never loads the client (and its native library)
    const { KafkaJS: client } = await import('@confluentinc/kafka-javascript');
    closed();
    this.kafka = new client.Kafka({
      kafkaJS: { clientId, brokers, ssl, ...(sasl && { sasl }), logger: clientLogger() },
      ...(addressFamily !== 'any' && { 'broker.address.family': addressFamily }),
    });

    // Assigned before connecting, so close() can disconnect a client that is still trying
    this.producer = this.kafka.producer({ 'message.timeout.ms': sendTimeoutMs });
    await this.producer.connect();
    closed();

    if (this.handlers.size > 0) {
      this.consumer = this.kafka.consumer({ kafkaJS: { groupId, fromBeginning } });
      await this.consumer.connect();
      closed();
      await this.consumer.subscribe({ topics: [...this.handlers.keys()] });
      await this.consumer.run({ eachMessage: (payload) => this.dispatch(payload) });
      closed();
    }

    if (this.config.healthCheckIntervalMs > 0) {
      this.admin = this.kafka.admin();
      await this.admin.connect();
      closed();
    }
    this.health.start(this.config.healthCheckIntervalMs);
    this.ready = true;
  }

  /** Publishes one or more messages; throws if the connector is not ready or the broker rejects them. */
  async send(topic: string, messages: OutgoingMessage | OutgoingMessage[]): Promise<void> {
    if (!this.config.enabled) throw new Error('Kafka connector is disabled (set KAFKA_ENABLED=true)');
    if (!this.ready || !this.producer) throw new Error('Kafka connector is not ready');
    // Propagates the current request context (x-request-id, traceparent) unless the message sets its own
    const batch = (Array.isArray(messages) ? messages : [messages]).map((message) => ({
      ...message,
      headers: { ...contextHeaders(), ...message.headers },
    }));
    await this.producer.send({ topic, messages: batch });
    logger.debug({ info: 'Kafka messages sent', topic, count: batch.length });
  }

  async close(): Promise<void> {
    this.generation++;
    this.ready = false;
    this.health.stop();
    // The consumer first, so no handler is left running without a producer for its dead letters
    const clients = { consumer: this.consumer, admin: this.admin, producer: this.producer };
    this.consumer = this.admin = this.producer = this.kafka = undefined;
    for (const [name, client] of Object.entries(clients)) {
      // One client failing to disconnect must not leave the others connected
      await client?.disconnect().catch((error) => logger.error({ info: `Kafka ${name} failed to disconnect`, error }));
    }
  }

  isReady(): boolean {
    return this.ready && this.health.healthy;
  }

  private async dispatch({ topic, partition, message }: KafkaJS.EachMessagePayload): Promise<void> {
    const incoming: IncomingMessage = {
      topic,
      partition,
      offset: message.offset,
      key: message.key?.toString() ?? null,
      value: message.value?.toString() ?? null,
      headers: decodeHeaders(message.headers),
    };
    try {
      // The handler runs in a request context rebuilt from the message headers, so its logs and calls correlate
      await runWithContext(contextFromHeaders(incoming.headers), () => this.handlers.get(topic)!(incoming));
    } catch (error) {
      // Message values are not logged: they may contain personal data
      const context = { topic, partition, offset: message.offset, key: incoming.key };
      logger.error({ info: 'Kafka message handler failed', ...context, error });
      if (!this.config.deadLetterSuffix) throw error;

      const deadLetterTopic = `${topic}${this.config.deadLetterSuffix}`;
      await this.producer!.send({
        topic: deadLetterTopic,
        messages: [
          {
            key: message.key,
            value: message.value,
            headers: {
              ...incoming.headers,
              'x-error': error instanceof Error ? error.message : String(error),
              'x-original-topic': topic,
              'x-original-partition': String(partition),
              'x-original-offset': message.offset,
            },
          },
        ],
      });
      logger.warn({ info: 'Kafka message sent to dead-letter topic', ...context, deadLetterTopic });
    }
  }
}

const kafkaEnv = z
  .object({
    KAFKA_ENABLED: envBoolean(false),
    KAFKA_CLIENT_ID: envString(config.appName),
    KAFKA_BROKERS: envList('localhost:9092'),
    KAFKA_GROUP_ID: envString(`${config.appName}-group`),
    KAFKA_FROM_BEGINNING: envBoolean(false),
    KAFKA_SSL: envBoolean(false),
    KAFKA_SASL_MECHANISM: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.enum(['plain', 'scram-sha-256', 'scram-sha-512']).optional(),
    ),
    KAFKA_SASL_USERNAME: envOptional(),
    KAFKA_SASL_PASSWORD: envOptional(),
    /** Unset: `.dlq`; empty: no dead-letter topic. */
    KAFKA_DEAD_LETTER_SUFFIX: z.string().default('.dlq'),
    KAFKA_SEND_TIMEOUT_MS: envNumber(30_000, { min: 1 }),
    KAFKA_HEALTH_CHECK_INTERVAL_MS: envNumber(10_000),
    KAFKA_ADDRESS_FAMILY: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.enum(['any', 'v4', 'v6']).default('any'),
    ),
  })
  .superRefine((env, ctx) => {
    if (env.KAFKA_SASL_MECHANISM && (!env.KAFKA_SASL_USERNAME || !env.KAFKA_SASL_PASSWORD)) {
      ctx.addIssue({
        code: 'custom',
        path: ['KAFKA_SASL_USERNAME'],
        message: 'KAFKA_SASL_USERNAME and KAFKA_SASL_PASSWORD are required when KAFKA_SASL_MECHANISM is set',
      });
    }
  })
  .transform((env): KafkaConfig => ({
    enabled: env.KAFKA_ENABLED,
    clientId: env.KAFKA_CLIENT_ID,
    brokers: env.KAFKA_BROKERS,
    groupId: env.KAFKA_GROUP_ID,
    fromBeginning: env.KAFKA_FROM_BEGINNING,
    ssl: env.KAFKA_SSL,
    sasl: env.KAFKA_SASL_MECHANISM
      ? { mechanism: env.KAFKA_SASL_MECHANISM, username: env.KAFKA_SASL_USERNAME!, password: env.KAFKA_SASL_PASSWORD! }
      : null,
    deadLetterSuffix: env.KAFKA_DEAD_LETTER_SUFFIX,
    sendTimeoutMs: env.KAFKA_SEND_TIMEOUT_MS,
    healthCheckIntervalMs: env.KAFKA_HEALTH_CHECK_INTERVAL_MS,
    addressFamily: env.KAFKA_ADDRESS_FAMILY,
  }));

/** Reads the `KAFKA_*` environment variables. */
export function kafkaConfigFromEnv(env: Record<string, string | undefined> = process.env): KafkaConfig {
  return parseEnv(kafkaEnv, env);
}

export default new KafkaConnector(loadOrExit(() => kafkaConfigFromEnv()));
