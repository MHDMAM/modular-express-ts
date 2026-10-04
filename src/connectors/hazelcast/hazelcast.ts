import type { Client, ClientConfig, ILogger, IMap, LifecycleState, ReconnectMode } from 'hazelcast-client';
import { z } from 'zod';

import { envBoolean, envList, envString, loadOrExit, parseEnv } from '#config';
import type { Connector } from '#core/lifecycle';
import logger from '#core/logger';

import type { Cache } from '../cache.js';

export interface HazelcastConfig {
  enabled: boolean;
  /** Map used by the `Cache` methods (`get`, `set`, `delete`). */
  mapName: string;
  /** Passed to the Hazelcast client as-is (cluster name, members, connection strategy, ...). */
  client: ClientConfig;
}

/** Routes the client's own log output through the application logger (it prints to the console otherwise). */
function clientLogger(): ILogger {
  const forward =
    (level: 'info' | 'warn' | 'error' | 'debug') => (objectName: string, message: string, furtherInfo?: unknown) =>
      logger[level]({
        info: `Hazelcast client: ${message}`,
        source: objectName,
        ...(furtherInfo ? { furtherInfo } : {}),
      });
  const levels = [forward('error'), forward('error'), forward('warn'), forward('info'), forward('debug')];
  return {
    // LogLevel: OFF, ERROR, WARN, INFO, DEBUG, TRACE
    log: (level, objectName, message, furtherInfo) =>
      (levels[level] ?? forward('debug'))(objectName, message, furtherInfo),
    error: forward('error'),
    warn: forward('warn'),
    info: forward('info'),
    debug: forward('debug'),
    trace: forward('debug'),
  };
}

/**
 * Hazelcast client exposing distributed maps, and a `Cache` over the default map. The `Cache` methods store values as
 * JSON text, like the Redis connector: the client's own serialization guesses the type of an array from its first
 * item (`[1, 'two']` comes back as `[1, null]`) and cannot store `null`. Maps from `map()` use the client's
 * serialization.
 *
 * ```ts
 * import hazelcast from '#connectors/hazelcast/hazelcast';
 * await hazelcast.set(`user:${id}`, user, 60_000);
 * const sessions = await hazelcast.map<Session>('sessions');
 * ```
 */
export class HazelcastConnector implements Connector, Cache {
  readonly name = 'hazelcast';
  private client?: Client;
  private readonly maps = new Map<string, Promise<IMap<string, unknown>>>();
  private connected = false;
  /** Settles the init() waiting for the first connection: called without error once connected. */
  private onConnected?: (error?: Error) => void;
  /** Incremented by init() and close(), so an init() still starting the client knows it was closed meanwhile. */
  private generation = 0;

  constructor(private readonly config: HazelcastConfig) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  async init(): Promise<void> {
    const generation = ++this.generation;
    this.connected = false;
    const clientConfig: ClientConfig = {
      customLogger: clientLogger(),
      ...this.config.client,
      lifecycleListeners: [...(this.config.client.lifecycleListeners ?? []), (state) => this.onLifecycle(state)],
    };
    // Loaded here, not at import time: a disabled connector never loads the client
    const { Client: HazelcastClient } = await import('hazelcast-client');
    if (generation !== this.generation) throw new Error('Hazelcast connector was closed during init');
    const client = await HazelcastClient.newHazelcastClient(clientConfig);
    if (generation !== this.generation) {
      // close() ran while the client was starting and could not reach it
      await client.shutdown();
      throw new Error('Hazelcast connector was closed during init');
    }
    this.client = client;
    // With `asyncStart` the client is returned before it is connected: it keeps trying, and close() can stop it
    if (!this.connected) {
      await new Promise<void>((resolve, reject) => {
        this.onConnected = (error) => (error ? reject(error) : resolve());
      });
    }
  }

  async close(): Promise<void> {
    this.generation++;
    const client = this.client;
    this.client = undefined;
    this.maps.clear();
    this.connected = false;
    this.onConnected?.(new Error('Hazelcast connector was closed during init'));
    this.onConnected = undefined;
    await client?.shutdown();
  }

  isReady(): boolean {
    return this.connected;
  }

  /** Returns a distributed map by name (defaults to `hazelcast.mapName`). */
  map<V>(name: string = this.config.mapName): Promise<IMap<string, V>> {
    if (!this.config.enabled) throw new Error('Hazelcast connector is disabled (set HAZELCAST_ENABLED=true)');
    if (!this.client) throw new Error('Hazelcast connector is not ready');
    let map = this.maps.get(name);
    if (!map) {
      const created = this.client.getMap<string, unknown>(name);
      this.maps.set(name, (map = created));
      // Not kept when it failed (e.g. the cluster was unreachable), so the next call asks again
      created.catch(() => this.maps.get(name) === created && this.maps.delete(name));
    }
    return map as Promise<IMap<string, V>>;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const value = await (await this.map<unknown>()).get(key);
    if (value === null) return undefined;
    try {
      if (typeof value === 'string') return JSON.parse(value) as T;
    } catch {
      // Reported below
    }
    // Written by something else (e.g. through `map()`); the value itself is not reported
    throw new Error(`Hazelcast: the value of "${key}" is not JSON`);
  }

  /** Hazelcast expires entries with a resolution of about a second: an entry can be gone up to a second early. */
  async set<T>(key: string, value: T, ttlMs = 0): Promise<void> {
    if (value === undefined) throw new TypeError('Hazelcast: cannot cache undefined');
    await (await this.map<string>()).set(key, JSON.stringify(value), ttlMs);
  }

  async delete(key: string): Promise<void> {
    await (await this.map()).delete(key);
  }

  private onLifecycle(state: LifecycleState) {
    if (String(state) === 'CONNECTED') {
      this.connected = true;
      this.onConnected?.();
      this.onConnected = undefined;
    }
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
        // The client is returned at once and keeps connecting: init() waits for it, close() can stop it
        asyncStart: true,
        // While disconnected, operations fail at once instead of waiting for the cluster
        reconnectMode: 'ASYNC' as ReconnectMode,
        connectionRetry: {
          initialBackoffMillis: 1000,
          maxBackoffMillis: 60000,
          multiplier: 2,
          jitter: 0.1,
          // Never gives up: with a limit, the client shuts itself down for good after an outage longer than it.
          // Startup is bounded by the connector init timeout instead
          clusterConnectTimeoutMillis: -1,
        },
      },
    },
  }));

/** Reads the `HAZELCAST_*` environment variables; extend `client` in code for other client options. */
export function hazelcastConfigFromEnv(env: Record<string, string | undefined> = process.env): HazelcastConfig {
  return parseEnv(hazelcastEnv, env);
}

export default new HazelcastConnector(loadOrExit(() => hazelcastConfigFromEnv()));
