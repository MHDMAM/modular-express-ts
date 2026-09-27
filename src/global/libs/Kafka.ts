import logger from '@utils/logger';
import { Consumer, Kafka, Producer } from 'kafkajs';

export default class KafkaManager {
  private static instance: KafkaManager;
  private kafka: Kafka;
  private producer: Producer;
  private consumer: Consumer;

  private constructor() {}

  public static getInstance(): KafkaManager {
    if (!this.instance) {
      this.instance = new KafkaManager();
    }
    return this.instance;
  }

  public async initialize(config: {
    clientId: string;
    brokers: string[];
    groupId?: string;
    transactionalId?: string;
  }): Promise<void> {
    if (!config || !config.brokers?.length || !config.clientId) {
      throw new Error('Invalid Kafka configuration: clientId and brokers are required');
    }

    const groupId = config.groupId || 'default-group-id'; // Default groupId fallback

    this.kafka = new Kafka({ clientId: config.clientId, brokers: config.brokers });

    this.producer = this.kafka.producer({ transactionalId: config.transactionalId || 'default-transactional-id' });
    this.consumer = this.kafka.consumer({ groupId });

    await this.producer.connect();
    logger.info({ info: 'Producer connected to Kafka' });

    await this.consumer.connect();
    logger.info({ info: 'Consumer connected to Kafka with groupId', groupId });
  }

  public async sendMessage(topic: string, key: string, value: string): Promise<void> {
    try {
      await this.producer.send({ topic, messages: [{ key, value }] });
      logger.info({ info: 'Message sent', topic, key, value });
    } catch (error) {
      logger.error({ info: 'Error sending Kafka message:', error });
      throw error;
    }
  }

  public async startConsumer(
    callback: (data: { topic: string; partition: number; message: string }) => Promise<void>,
    topic: string,
  ): Promise<void> {
    if (!this.consumer) {
      throw new Error('Kafka consumer is not initialized');
    }

    try {
      await this.consumer.subscribe({ topic, fromBeginning: true });
      logger.info({ info: 'Subscribed to topic', topic });

      await this.consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          const value = message.value?.toString() || '';
          logger.info({ info: 'Message received', topic, partition, value });
          await callback({ topic, partition, message: value });
        },
      });
    } catch (error) {
      logger.error({ info: 'Error running Kafka consumer', error });
      throw error;
    }
  }
}
