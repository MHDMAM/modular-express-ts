import registry from '@/connectors';
import { Connector } from '@lTypes/connector';
import { formatStatus } from '@utils/HttpException';
import { closeConnectors, connectorStatus, initConnectors } from '@utils/lifecycle';
import { startTestApp, TestApp } from './support/testApp';

function fakeConnector(name: string, opts: { enabled?: boolean; failInit?: boolean; failClose?: boolean } = {}) {
  let ready = false;
  const calls: string[] = [];
  const connector: Connector & { calls: string[] } = {
    name,
    enabled: opts.enabled ?? true,
    calls,
    init: jest.fn(async () => {
      calls.push(`init:${name}`);
      if (opts.failInit) throw new Error(`${name} init failed`);
      ready = true;
    }),
    close: jest.fn(async () => {
      calls.push(`close:${name}`);
      ready = false;
      if (opts.failClose) throw new Error(`${name} close failed`);
    }),
    isReady: () => ready,
  };
  return connector;
}

describe('connector lifecycle', () => {
  it('initialises enabled connectors in order and skips disabled ones', async () => {
    const a = fakeConnector('a');
    const b = fakeConnector('b', { enabled: false });
    const c = fakeConnector('c');

    await initConnectors([a, b, c]);

    expect(a.init).toHaveBeenCalled();
    expect(b.init).not.toHaveBeenCalled();
    expect(c.init).toHaveBeenCalled();
    expect(connectorStatus([a, b, c])).toEqual({ a: true, c: true });
  });

  it('closes already started connectors and rethrows when one fails to initialise', async () => {
    const order: string[] = [];
    const a = fakeConnector('a');
    const b = fakeConnector('b');
    const c = fakeConnector('c', { failInit: true });
    const d = fakeConnector('d');
    [a, b, c, d].forEach((x) => (x.calls.push = (...items: string[]) => order.push(...items)));

    await expect(initConnectors([a, b, c, d])).rejects.toThrow('c init failed');

    expect(order).toEqual(['init:a', 'init:b', 'init:c', 'close:b', 'close:a']);
    expect(d.init).not.toHaveBeenCalled();
  });

  it('closes connectors in reverse order and keeps going when one fails', async () => {
    const order: string[] = [];
    const a = fakeConnector('a');
    const b = fakeConnector('b', { failClose: true });
    const c = fakeConnector('c');
    [a, b, c].forEach((x) => (x.calls.push = (...items: string[]) => order.push(...items)));

    await expect(closeConnectors([a, b, c])).resolves.toBeUndefined();

    expect(order).toEqual(['close:c', 'close:b', 'close:a']);
  });
});

describe('GET /health/ready', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startTestApp();
  });

  afterAll(() => app.close());

  afterEach(() => {
    registry.length = 0;
  });

  it('is ready when every enabled connector is ready', async () => {
    const connector = fakeConnector('cache');
    await connector.init();
    registry.push(connector, fakeConnector('disabled', { enabled: false }));

    const res = await fetch(`${app.url}/health/ready`);
    const body: any = await res.json();

    expect(res.status).toBe(200);
    expect(body.payload).toEqual({ ready: true, connectors: { cache: true } });
  });

  it('returns 503 when a connector is not ready', async () => {
    registry.push(fakeConnector('broker'));

    const res = await fetch(`${app.url}/health/ready`);
    const body: any = await res.json();

    expect(res.status).toBe(503);
    expect(body.status).toBe(formatStatus(6));
    expect(body.payload).toEqual({ ready: false, connectors: { broker: false } });
  });
});
