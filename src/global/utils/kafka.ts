import KafkaManager from '@libs/Kafka';
import logger from '@utils/logger';
import config from 'config';

interface KafkaConfig {
  clientId: string;
  brokers: string[];
  enabled: boolean;
  consumerEnabled: boolean;
  groupId: string;
  transactionalId?: string;
  topicName: string; // Include the topicName property
}

class KafkaInstance {
  private kafkaManager: KafkaManager;
  private topic: string;
  private kafkaEnabled: boolean;
  constructor(config: KafkaConfig) {
    this.kafkaManager = KafkaManager.getInstance();
    this.topic = config.topicName; // Use the topicName from config
    this.kafkaEnabled = true;
    this.initialize(config);
  }

  private async initialize(config: KafkaConfig): Promise<void> {
    logger.info({ info: 'Kafka Initialize', config });
    if (!config.enabled) {
      logger.info({ info: 'Kafka is disabled' });
      this.kafkaEnabled = false;
      return;
    }

    try {
      const { clientId, brokers, groupId } = config;

      if (!groupId) {
        logger.error({ info: 'KafkaConfig missing groupId; using default' });
      }

      await this.kafkaManager.initialize({
        clientId,
        brokers,
        groupId: groupId || 'default-group-id', // Fallback if groupId is missing
      });

      logger.info({ info: 'KafkaManager initialized successfully' });

      if (config.consumerEnabled) {
        await this.startConsumer();
      }
    } catch (error) {
      logger.error({ info: 'Error initializing KafkaManager in KafkaInstance:', error });
    }
  }

  public async sendMessage(key: string, value: string): Promise<void | boolean> {
    try {
      if (!this.kafkaEnabled) {
        return false;
      }
      await this.kafkaManager.sendMessage(this.topic, key, value);
    } catch (error) {
      logger.error({ info: 'Error sending message:', error });
    }
  }

  private async startConsumer(): Promise<void> {
    try {
      await this.kafkaManager.startConsumer(async ({ topic, partition, message }) => {
        logger.info({ info: 'Processing message', topic, partition, message });
        // Add your business logic here
      }, this.topic);
    } catch (error) {
      logger.error({ info: 'Error starting Kafka consumer:', error });
    }
  }
}

export default KafkaInstance;

const kafkaConfig = config.get<KafkaConfig>('kafka');

export let kafkaInstance: KafkaInstance;

if (!kafkaConfig.enabled) {
  logger.info({ info: 'Kafka is Turned off' });
} else {
  kafkaInstance = new KafkaInstance(kafkaConfig);
}
