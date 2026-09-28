import registry from '#connectors';
import { formatStatus } from '#core/errors';
import { initConnectors } from '#core/lifecycle';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fakeConnector } from '../../../test/support/fake-connector.js';
import { startTestApp, TestApp } from '../../../test/support/test-app.js';

describe('GET /health/ready', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startTestApp();
  });

  afterAll(() => app.close());

  afterEach(() => {
    registry.length = 0;
  });

  it('is ready when every enabled connector is running', async () => {
    const connector = fakeConnector('cache');
    await initConnectors([connector]);
    registry.push(connector, fakeConnector('disabled', { enabled: false }));

    const res = await fetch(`${app.url}/health/ready`);
    const body: any = await res.json();

    expect(res.status).toBe(200);
    expect(body.payload).toEqual({ ready: true, connectors: { cache: 'running' } });
  });

  it('returns 503 with the status of each connector otherwise', async () => {
    const down = fakeConnector('cache');
    await initConnectors([down]);
    down.setReady(false);
    registry.push(down, fakeConnector('broker'));

    const res = await fetch(`${app.url}/health/ready`);
    const body: any = await res.json();

    expect(res.status).toBe(503);
    expect(body.status).toBe(formatStatus(6));
    expect(body.payload).toEqual({ ready: false, connectors: { cache: 'unavailable', broker: 'stopped' } });
  });
});
