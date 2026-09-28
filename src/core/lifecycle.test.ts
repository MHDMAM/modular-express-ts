import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkConnectors,
  closeConnectors,
  connectorStatus,
  getConnectorStatus,
  initConnectors,
  startConnectorMonitor,
  stopConnectorMonitor,
} from '#core/lifecycle';
import logger from '#core/logger';

import { FakeConnector, fakeConnector } from '../../test/support/fake-connector.js';

/** Records the order of init/close calls across connectors. */
function trackOrder(...connectors: FakeConnector[]) {
  const order: string[] = [];
  connectors.forEach((c) => (c.calls.push = (...items: string[]) => order.push(...items)));
  return order;
}

/** Log entries (the object passed to the logger) for a given `info` message. */
function logged(spy: { mock: { calls: unknown[][] } }, info: string) {
  return spy.mock.calls.map(([entry]) => entry as Record<string, unknown>).filter((entry) => entry?.info === info);
}

describe('connector lifecycle', () => {
  let info: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    info = vi.spyOn(logger, 'info');
    warn = vi.spyOn(logger, 'warn');
    error = vi.spyOn(logger, 'error');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    stopConnectorMonitor();
  });

  it('initialises enabled connectors in order and reports disabled ones', async () => {
    const a = fakeConnector('a');
    const b = fakeConnector('b', { enabled: false });
    const c = fakeConnector('c');

    await initConnectors([a, b, c]);

    expect(b.init).not.toHaveBeenCalled();
    expect(connectorStatus([a, b, c])).toEqual({ a: 'running', c: 'running' });
    expect(getConnectorStatus(b)).toBe('disabled');
  });

  it('logs every status change and a startup summary', async () => {
    const a = fakeConnector('a');
    const b = fakeConnector('b', { enabled: false });

    await initConnectors([a, b]);

    expect(logged(info, 'Connector starting')).toEqual([expect.objectContaining({ connector: 'a' })]);
    expect(logged(info, 'Connector running')).toEqual([
      expect.objectContaining({ connector: 'a', previous: 'starting', durationMs: expect.any(Number) }),
    ]);
    expect(logged(info, 'Connector disabled')).toEqual([expect.objectContaining({ connector: 'b' })]);
    expect(logged(info, 'Connectors started')).toEqual([
      expect.objectContaining({ connectors: { a: 'running', b: 'disabled' } }),
    ]);
  });

  it('marks a connector failed, closes it and the started ones, and rethrows', async () => {
    const a = fakeConnector('a');
    const b = fakeConnector('b');
    const c = fakeConnector('c', { failInit: true });
    const d = fakeConnector('d');
    const order = trackOrder(a, b, c, d);

    await expect(initConnectors([a, b, c, d])).rejects.toThrow('c init failed');

    expect(order).toEqual(['init:a', 'init:b', 'init:c', 'close:c', 'close:b', 'close:a']);
    expect(d.init).not.toHaveBeenCalled();
    expect(getConnectorStatus(c)).toBe('failed');
    expect(getConnectorStatus(a)).toBe('stopped');
    expect(logged(error, 'Connector failed')).toEqual([
      expect.objectContaining({ connector: 'c', error: expect.any(Error) }),
    ]);
  });

  it('times out a connector that never becomes ready and closes it to stop its retries', async () => {
    const a = fakeConnector('a');
    const stuck = fakeConnector('stuck');
    stuck.init = vi.fn(() => new Promise<void>(() => undefined));

    await expect(initConnectors([a, stuck], 50)).rejects.toThrow('stuck was not ready within 50ms');

    expect(stuck.close).toHaveBeenCalled();
    expect(a.close).toHaveBeenCalled();
    expect(getConnectorStatus(stuck)).toBe('failed');
  });

  it('closes connectors in reverse order, marks them stopped and keeps going when one fails', async () => {
    const a = fakeConnector('a');
    const b = fakeConnector('b', { failClose: true });
    const c = fakeConnector('c');
    await initConnectors([a, b, c]);
    const order = trackOrder(a, b, c);

    await expect(closeConnectors([a, b, c])).resolves.toBeUndefined();

    expect(order).toEqual(['close:c', 'close:b', 'close:a']);
    expect(getConnectorStatus(a)).toBe('stopped');
    expect(getConnectorStatus(c)).toBe('stopped');
    expect(logged(error, 'Connector failed to close')).toEqual([expect.objectContaining({ connector: 'b' })]);
  });

  it('does not wait forever for a connector that hangs while closing', async () => {
    const a = fakeConnector('a');
    const hanging = fakeConnector('hanging');
    await initConnectors([a, hanging]);
    hanging.close = vi.fn(() => new Promise<void>(() => undefined));

    await closeConnectors([a, hanging], 50);

    expect(a.close).toHaveBeenCalled();
    expect(logged(error, 'Connector failed to close')).toEqual([
      expect.objectContaining({
        connector: 'hanging',
        error: expect.objectContaining({ message: 'hanging did not close within 50ms' }),
      }),
    ]);
  });

  it('reports a running connector that is not ready as unavailable, and logs when it goes and comes back', async () => {
    const a = fakeConnector('a');
    await initConnectors([a]);

    a.setReady(false);
    expect(getConnectorStatus(a)).toBe('unavailable');
    checkConnectors([a]);
    expect(logged(warn, 'Connector unavailable')).toEqual([expect.objectContaining({ connector: 'a' })]);

    a.setReady(true);
    checkConnectors([a]);
    expect(getConnectorStatus(a)).toBe('running');
    expect(logged(info, 'Connector running')).toHaveLength(2);
  });

  it('checks connectors periodically once the monitor is started', async () => {
    vi.useFakeTimers();
    try {
      const a = fakeConnector('a');
      await initConnectors([a]);
      startConnectorMonitor([a], 1_000);

      a.setReady(false);
      vi.advanceTimersByTime(1_000);

      expect(logged(warn, 'Connector unavailable')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
