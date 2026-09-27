import { envBoolean, envList, envNumber, envString, parseEnv } from '@/config';
import type { Connector } from '@core/lifecycle';
import logger from '@core/logger';
import type { Client, ClientConfig, IMap, LifecycleState, ReconnectMode } from 'hazelcast-client';
import { z } from 'zod';
import type { Cache } from '../cache';

export interface HazelcastConfig {
  enabled: boolean;
  /** Map used by the `Cache` methods (`get`, `set`, `delete`). */
  mapName: string;
  /** Passed to the Hazelcast client as-is (cluster name, members, connection strategy, ...). */
  client: ClientConfig;
}

/**
 * Hazelcast client exposing distributed maps, and a `Cache` over the default map.
 *
 * ```ts
 * import hazelcast from '@connectors/hazelcast/hazelcast';
 * await hazelcast.set(`user:${id}`, user, 60_000);
 * const sessions = await hazelcast.map<Session>('sessions');
 * ```
 */
export class HazelcastConnector implements Connector, Cache {
  readonly name = 'hazelcast';
  private client?: Client;
  private readonly maps = new Map<string, Promise<IMap<string, unknown>>>();
  private connected = false;

  constructor(private readonly config: HazelcastConfig) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  async init(): Promise<void> {
    const clientConfig: ClientConfig = {
      ...this.config.client,
      lifecycleListeners: [...(this.config.client.lifecycleListeners ?? []), (state) => this.onLifecycle(state)],
    };
    // Loaded here, not at import time: a disabled connector never loads the client
    const { Client: HazelcastClient } = await import('hazelcast-client');
    this.client = await HazelcastClient.newHazelcastClient(clientConfig);
    this.connected = true;
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.maps.clear();
    this.connected = false;
    await client?.shutdown();
  }

  isReady(): boolean {
    return this.connected;
  }

  /** Returns a distributed map by name (defaults to `hazelcast.mapName`). */
  map<V>(name: string = this.config.mapName): Promise<IMap<string, V>> {
    if (!this.client) throw new Error('Hazelcast connector is not ready');
    let map = this.maps.get(name);
    if (!map) {
      map = this.client.getMap<string, unknown>(name);
      this.maps.set(name, map);
    }
    return map as Promise<IMap<string, V>>;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const value = await (await this.map<T>()).get(key);
    return value ?? undefined;
  }

  async set<T>(key: string, value: T, ttlMs = 0): Promise<void> {
    await (await this.map<T>()).set(key, value, ttlMs);
  }

  async delete(key: string): Promise<void> {
    await (await this.map()).delete(key);
  }

  private onLifecycle(state: LifecycleState) {
    if (String(state) === 'CONNECTED') this.connected = true;
    if (['DISCONNECTED', 'SHUTTING_DOWN', 'SHUTDOWN'].includes(String(state))) {
      this.connected = false;
    }
    logger.info({ info: 'Hazelcast lifecycle', state });
  }
}

const hazelcastEnv = z
  .object({
    HAZELCAST_ENABLED: envBoolean(false),
    HAZELCAST_CLUSTER_NAME: envString('dev'),
    HAZELCAST_MEMBERS: envList('127.0.0.1:5701'),
    HAZELCAST_MAP_NAME: envString('default'),
    /** The client stops retrying an unreachable cluster after this long (it would retry forever otherwise). */
    HAZELCAST_CONNECT_TIMEOUT_MS: envNumber(20_000, { min: 1 }),
  })
  .transform((env): HazelcastConfig => ({
    enabled: env.HAZELCAST_ENABLED,
    mapName: env.HAZELCAST_MAP_NAME,
    client: {
      clusterName: env.HAZELCAST_CLUSTER_NAME,
      network: {
        clusterMembers: env.HAZELCAST_MEMBERS,
        smartRouting: true,
        redoOperation: true,
        connectionTimeout: 6000,
      },
      connectionStrategy: {
        asyncStart: false,
        reconnectMode: 'ASYNC' as ReconnectMode,
        connectionRetry: {
          initialBackoffMillis: 1000,
          maxBackoffMillis: 60000,
          multiplier: 2,
          jitter: 0.1,
          clusterConnectTimeoutMillis: env.HAZELCAST_CONNECT_TIMEOUT_MS,
        },
      },
    },
  }));

/** Reads the `HAZELCAST_*` environment variables; extend `client` in code for other client options. */
export function hazelcastConfigFromEnv(env: Record<string, string | undefined> = process.env): HazelcastConfig {
  return parseEnv(hazelcastEnv, env);
}

export default new HazelcastConnector(hazelcastConfigFromEnv());
