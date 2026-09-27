import config from 'config';
import { ClientConfig } from 'hazelcast-client';
import * as _ from 'lodash';

import HazelcastManager from '@libs/Hazelcast';
import logger from '@utils/logger';

interface HazelcastConfig {
  enabled: boolean;
  mapName: string;
  client: ClientConfig;
}

const hzConfig = config.get<HazelcastConfig>('hazelcast');

const hazelcastClientConfig: ClientConfig = _.assign(
  {
    lifecycleListeners: [
      (state) => {
        logger.info({ info: `Lifecycle Event >>> ${state}` });
      },
    ],
  },
  hzConfig.client,
);

class HazelcastInstance {
  _ready!: Promise<void>;
  hazelcastManager: HazelcastManager;
  mapName: string;

  constructor(clientConfig: ClientConfig, mapName: string) {
    this.mapName = mapName;
    this.connect(clientConfig);
  }

  private async connect(clientConfig: ClientConfig) {
    this._ready = new Promise(async (resolve, reject) => {
      try {
        this.hazelcastManager = HazelcastManager.getInstance();
        await this.hazelcastManager.initialize(clientConfig);
        return resolve();
      } catch (error) {
        logger.error({ info: 'Failed to initialize Hazelcast client', error });
        return reject(error);
      }
    });
  }

  async cacheIn(key: string, value: object, ttl: number = 0) {
    await this._ready;
    let start: bigint = process.hrtime.bigint();
    await this.hazelcastManager.set(this.mapName, key, value, ttl);
    let benchmark: bigint = (process.hrtime.bigint() - start) / 1000000n;
    logger.info({ info: 'Benchmark, Cache In Data SET', benchmark: `${benchmark}`, key, value, ttl });
    return true;
  }

  async cacheOut<T>(key: string): Promise<T> {
    await this._ready;
    let start: bigint = process.hrtime.bigint();
    const cacheResp: T = await this.hazelcastManager.getDataFromMap(this.mapName, key);
    let benchmark: bigint = (process.hrtime.bigint() - start) / 1000000n;
    logger.info({ info: 'Benchmark, Cache Out Data', benchmark: `${benchmark}`, cacheResp, key });
    return cacheResp;
  }

  async removeDataFromMap<T>(key: string): Promise<boolean | T> {
    await this._ready;
    return await this.hazelcastManager.removeFromMap(this.mapName, key);
  }

  shutdown(): Promise<void> {
    return this.hazelcastManager.shutdown();
  }
}

export let hazelcastInstance: HazelcastInstance;
if (!hzConfig.enabled) {
  logger.info({ info: 'Hazelcast is Turned off' });
} else {
  hazelcastInstance = new HazelcastInstance(hazelcastClientConfig, hzConfig.mapName);
}
