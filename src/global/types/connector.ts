/**
 * An external dependency (message broker, cache, database, ...) with an explicit lifecycle.
 * Connectors listed in `src/connectors.ts` are initialised before the server starts listening and closed on shutdown.
 */
export interface Connector {
  readonly name: string;
  /** Disabled connectors are skipped by the lifecycle and not reported by the readiness check. */
  readonly enabled: boolean;
  init(): Promise<void>;
  close(): Promise<void>;
  isReady(): boolean;
}

/** Key/value cache implemented by the cache connectors, so modules do not depend on a specific backend. */
export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  /** `ttlMs` of 0 or undefined means no expiry. */
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
}
