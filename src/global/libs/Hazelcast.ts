import logger from '@utils/logger';
import { Client, ClientConfig, IMap } from 'hazelcast-client';

export default class HazelcastManager {
  private static instance: HazelcastManager;
  private hazelcastClient: Client;
  map: IMap<string, any>;

  private constructor() {
    // Private constructor to enforce singleton pattern
  }

  public static getInstance(): HazelcastManager {
    if (!HazelcastManager.instance) {
      HazelcastManager.instance = new HazelcastManager();
    }
    return HazelcastManager.instance;
  }

  public async initialize(config?: ClientConfig): Promise<void> {
    // Perform Hazelcast client initialization with the provided configuration
    this.hazelcastClient = await Client.newHazelcastClient(config);
    return Promise.resolve();
  }

  public async shutdown(): Promise<void> {
    // Perform cleanup, like removing listeners, etc.
    if (this.hazelcastClient) await this.hazelcastClient.shutdown();
  }

  public async getMap<T>(mapName: string): Promise<IMap<string, T>> {
    // Use the Hazelcast client instance to get a distributed map
    let start: bigint = process.hrtime.bigint();
    if (!this.map) this.map = await this.hazelcastClient.getMap(mapName);
    const benchmark = Number((process.hrtime.bigint() - start) / 1000000n);
    logger.info({ info: 'Benchmark, Get Map', benchmark });
    return Promise.resolve(this.map);
  }

  public async putDataIntoMap<T>(mapName: string, key: string, data: T, ttl: number = 0): Promise<T> {
    return (await this.getMap<T>(mapName)).put(key, data, ttl);
  }

  public async set<T>(mapName: string, key: string, data: T, ttl: number) {
    return (await this.getMap<T>(mapName)).set(key, data, ttl);
  }

  public async getDataFromMap<T>(mapName: string, key: string): Promise<T> {
    return (await this.getMap<T>(mapName)).get(key);
  }

  public async removeFromMap<T>(mapName: string, key: string): Promise<boolean | T> {
    return (await this.getMap<T>(mapName)).remove(key);
  }
}
