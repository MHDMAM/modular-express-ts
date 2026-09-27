/** Key/value cache implemented by the cache connectors, so modules do not depend on a specific backend. */
export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  /** `ttlMs` of 0 or undefined means no expiry. */
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
}
