import { vi } from 'vitest';

import type { Connector } from '#core/lifecycle';

export type FakeConnector = Connector & { calls: string[]; setReady(ready: boolean): void };

/** In-memory connector recording its init/close calls; `setReady` simulates losing and regaining the connection. */
export function fakeConnector(name: string, opts: { enabled?: boolean; failInit?: boolean; failClose?: boolean } = {}) {
  let ready = false;
  const calls: string[] = [];
  const connector: FakeConnector = {
    name,
    enabled: opts.enabled ?? true,
    calls,
    init: vi.fn(async () => {
      calls.push(`init:${name}`);
      if (opts.failInit) throw new Error(`${name} init failed`);
      ready = true;
    }),
    close: vi.fn(async () => {
      calls.push(`close:${name}`);
      ready = false;
      if (opts.failClose) throw new Error(`${name} close failed`);
    }),
    isReady: () => ready,
    setReady: (value) => (ready = value),
  };
  return connector;
}
