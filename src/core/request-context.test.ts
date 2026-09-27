import logger from '@core/logger';
import {
  contextFromHeaders,
  contextHeaders,
  formatTraceparent,
  getRequestContext,
  parseTraceparent,
  runWithContext,
} from '@core/request-context';
import { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import winston from 'winston';
import { startTestApp, TestApp } from '../../test/support/test-app';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;

/** Captures what the logger writes, parsed from its JSON lines. */
function captureLogs() {
  const lines: Record<string, any>[] = [];
  const transport = new winston.transports.Stream({
    stream: new Writable({
      write(chunk, _encoding, callback) {
        lines.push(JSON.parse(chunk.toString()));
        callback();
      },
    }),
  });
  logger.add(transport);
  return { lines, stop: () => logger.remove(transport) };
}

describe('traceparent', () => {
  it('extracts the trace id from a valid header', () => {
    expect(parseTraceparent(TRACEPARENT)).toBe(TRACE_ID);
    expect(parseTraceparent(` ${TRACEPARENT.toUpperCase()} `)).toBe(TRACE_ID);
  });

  it('rejects malformed headers and the all-zero trace id', () => {
    expect(parseTraceparent(undefined)).toBeUndefined();
    expect(parseTraceparent('garbage')).toBeUndefined();
    expect(parseTraceparent(`00-${'0'.repeat(32)}-00f067aa0ba902b7-01`)).toBeUndefined();
  });

  it('formats an outgoing header with the same trace id and a new span id', () => {
    const header = formatTraceparent(TRACE_ID);

    expect(parseTraceparent(header)).toBe(TRACE_ID);
    expect(header).not.toBe(formatTraceparent(TRACE_ID));
  });
});

describe('request context', () => {
  it('takes ids from incoming headers', () => {
    expect(contextFromHeaders({ 'x-request-id': 'req-1', traceparent: TRACEPARENT })).toEqual({
      requestId: 'req-1',
      traceId: TRACE_ID,
    });
  });

  it('generates missing ids', () => {
    const context = contextFromHeaders({});

    expect(context.requestId).toMatch(/^[\da-f-]{36}$/);
    expect(context.traceId).toMatch(/^[\da-f]{32}$/);
  });

  it('is undefined outside of a request, and so are propagation headers', () => {
    expect(getRequestContext()).toBeUndefined();
    expect(contextHeaders()).toEqual({});
  });

  it('follows async code and keeps concurrent requests apart', async () => {
    const handle = (requestId: string, delayMs: number) =>
      runWithContext({ requestId, traceId: TRACE_ID }, async () => {
        await sleep(delayMs);
        return getRequestContext()?.requestId;
      });

    await expect(Promise.all([handle('a', 30), handle('b', 5), handle('c', 15)])).resolves.toEqual(['a', 'b', 'c']);
  });

  it('builds propagation headers from the current context', () => {
    runWithContext({ requestId: 'req-1', traceId: TRACE_ID }, () => {
      const headers = contextHeaders();
      expect(headers['x-request-id']).toBe('req-1');
      expect(parseTraceparent(headers.traceparent)).toBe(TRACE_ID);
    });
  });
});

describe('logger', () => {
  let logs: ReturnType<typeof captureLogs>;
  beforeAll(() => (logs = captureLogs()));
  afterAll(() => logs.stop());
  afterEach(() => (logs.lines.length = 0));

  it('adds the request context to every line and puts object fields at the top level', () => {
    runWithContext({ requestId: 'req-1', traceId: TRACE_ID }, () => logger.info({ info: 'processing', orderId: 7 }));

    expect(logs.lines[0]).toMatchObject({
      level: 'info',
      requestId: 'req-1',
      traceId: TRACE_ID,
      info: 'processing',
      orderId: 7,
    });
    expect(logs.lines[0].time).toBeTruthy();
  });

  it('has no context fields outside of a request', () => {
    logger.info('startup');

    expect(logs.lines[0]).toMatchObject({ level: 'info', message: 'startup' });
    expect(logs.lines[0]).not.toHaveProperty('requestId');
  });

  it('serializes errors with message and stack, and bigints as strings', () => {
    logger.error({ info: 'failed', error: new Error('boom'), big: 10n });

    expect(logs.lines[0].error.message).toBe('boom');
    expect(logs.lines[0].error.stack).toContain('boom');
    expect(logs.lines[0].big).toBe('10');
  });
});

describe('HTTP requests', () => {
  let app: TestApp;
  let logs: ReturnType<typeof captureLogs>;
  beforeAll(async () => {
    app = await startTestApp();
    logs = captureLogs();
  });
  afterAll(async () => {
    logs.stop();
    await app.close();
  });

  it('correlates the logs of a request with the ids from its headers', async () => {
    const res = await fetch(`${app.url}/health`, { headers: { 'x-request-id': 'req-42', traceparent: TRACEPARENT } });

    expect(res.headers.get('x-request-id')).toBe('req-42');
    const requestLogs = logs.lines.filter((line) => line.requestId === 'req-42');
    expect(requestLogs.map((line) => line.info)).toEqual(['Request started', 'Request completed']);
    expect(requestLogs.every((line) => line.traceId === TRACE_ID)).toBe(true);
  });

  it('has the context when the request fails before reaching a route (invalid JSON body)', async () => {
    const res = await fetch(`${app.url}/health`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': 'req-bad-json', traceparent: TRACEPARENT },
      body: '{invalid',
    });
    const body: any = await res.json();

    expect(res.status).toBe(400);
    expect(res.headers.get('x-request-id')).toBe('req-bad-json');
    const failed = logs.lines.find((line) => line.info === 'Request failed' && line.requestId === 'req-bad-json');
    expect(failed?.traceId).toBe(TRACE_ID);
    expect(body._metadata.processingTime).toBeLessThan(10_000);
  });

  it('does not log request headers or bodies', async () => {
    await fetch(`${app.url}/health`, { headers: { authorization: 'Bearer secret-token' } });

    expect(JSON.stringify(logs.lines)).not.toContain('secret-token');
  });
});
