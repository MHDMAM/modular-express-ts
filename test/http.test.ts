import {
  CIRCUIT_OPEN,
  CircuitState,
  HttpClient,
  backoffDelayMs,
  retryAfterMs,
  type HttpResponse,
} from '@utils/HttpClient';
import logger from '@utils/logger';
import { parseTraceparent, runWithContext } from '@utils/requestContext';
import ServiceRequester from '@utils/ServiceRequester';
import config from 'config';
import http, { IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** Local HTTP server that answers each request with the next scripted handler (the last one repeats). */
class ScriptedServer {
  private readonly server = http.createServer((req, res) => {
    this.requests.push({ method: req.method!, url: req.url!, headers: req.headers });
    const handler = this.handlers.length > 1 ? this.handlers.shift()! : this.handlers[0];
    handler(req, res);
  });
  private handlers: Handler[] = [];
  requests: { method: string; url: string; headers: http.IncomingHttpHeaders }[] = [];
  url = '';

  async start() {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  respond(...handlers: Handler[]) {
    this.handlers = handlers;
    this.requests = [];
  }

  stop() {
    this.server.closeAllConnections();
    return new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const reply =
  (status: number, body: unknown = {}, headers: Record<string, string> = {}): Handler =>
  (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
const resetConnection: Handler = (req) => req.socket.destroy();
const delay =
  (ms: number, handler: Handler): Handler =>
  (req, res) =>
    setTimeout(() => handler(req, res), ms);

const fastRetry = { initialDelayMs: 1, maxDelayMs: 5 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const server = new ScriptedServer();
beforeAll(() => server.start());
afterAll(() => server.stop());

describe('retryAfterMs', () => {
  it('parses seconds and HTTP dates, and ignores invalid values', () => {
    expect(retryAfterMs({ 'retry-after': '2' })).toBe(2000);
    expect(retryAfterMs({ 'retry-after': ['0'] })).toBe(0);
    expect(retryAfterMs({ 'retry-after': new Date(Date.now() - 60_000).toUTCString() })).toBe(0);
    const future = retryAfterMs({ 'retry-after': new Date(Date.now() + 60_000).toUTCString() })!;
    expect(future).toBeGreaterThan(55_000);
    expect(retryAfterMs({ 'retry-after': 'soon' })).toBeUndefined();
    expect(retryAfterMs({})).toBeUndefined();
  });
});

describe('backoffDelayMs', () => {
  it('doubles per attempt with jitter between half and the full delay, capped at the maximum', () => {
    expect(backoffDelayMs(1, 100, 10_000, () => 0)).toBe(50);
    expect(backoffDelayMs(1, 100, 10_000, () => 1)).toBe(100);
    expect(backoffDelayMs(3, 100, 10_000, () => 1)).toBe(400);
    expect(backoffDelayMs(20, 100, 1_000, () => 1)).toBe(1_000);
  });
});

describe('HttpClient', () => {
  it('returns the response on success', async () => {
    server.respond(reply(200, { hello: 'world' }));

    const res = await new HttpClient().send({ url: server.url });

    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ status: 200, data: { hello: 'world' } });
  });

  it('retries retryable statuses until a request succeeds', async () => {
    server.respond(reply(503), reply(502), reply(200, { ok: true }));

    const res = await new HttpClient({ retry: fastRetry }).send({ url: server.url });

    expect(res.success).toBe(true);
    expect(server.requests).toHaveLength(3);
  });

  it('gives up after maxRetries and returns the last failure', async () => {
    server.respond(reply(503, { message: 'down' }));

    const res = await new HttpClient({ retry: { ...fastRetry, maxRetries: 2 } }).send({ url: server.url });

    expect(res.success).toBe(false);
    expect(res.reason).toMatchObject({ status: 503, data: { message: 'down' }, requestMadeNoResponse: false });
    expect(server.requests).toHaveLength(3);
  });

  it('does not retry non-idempotent methods by default', async () => {
    server.respond(reply(503));

    const res = await new HttpClient({ retry: fastRetry }).send({ url: server.url, method: 'POST', data: {} });

    expect(res.success).toBe(false);
    expect(server.requests).toHaveLength(1);
  });

  it('retries non-idempotent methods when configured to', async () => {
    server.respond(reply(503), reply(201));

    const client = new HttpClient({ retry: { ...fastRetry, methods: ['post'] } });
    const res = await client.send({ url: server.url, method: 'POST', data: {} });

    expect(res.success).toBe(true);
    expect(server.requests).toHaveLength(2);
  });

  it('does not retry client errors', async () => {
    server.respond(reply(400, { message: 'bad' }));

    const res = await new HttpClient({ retry: fastRetry }).send({ url: server.url });

    expect(res.reason).toMatchObject({ status: 400 });
    expect(server.requests).toHaveLength(1);
  });

  it('retries when the connection is reset', async () => {
    server.respond(resetConnection, reply(200));

    const res = await new HttpClient({ retry: fastRetry }).send({ url: server.url });

    expect(res.success).toBe(true);
    expect(server.requests).toHaveLength(2);
  });

  it('uses Retry-After instead of its own backoff', async () => {
    // With the configured backoff the retry would wait 2.5-5s; Retry-After: 0 makes it immediate
    server.respond(reply(503, {}, { 'retry-after': '0' }), reply(200));

    const started = Date.now();
    const client = new HttpClient({ retry: { initialDelayMs: 5_000, maxDelayMs: 5_000 } });
    const res = await client.send({ url: server.url });

    expect(res.success).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('reports a timeout when no response arrives in time', async () => {
    server.respond(delay(300, reply(200)));

    const res = await new HttpClient({ retry: false }).send({ url: server.url, timeout: 50 });

    expect(res.success).toBe(false);
    expect(res.reason).toMatchObject({ code: 'ECONNABORTED', requestMadeNoResponse: true });
  });

  it('reports connection failures without a response', async () => {
    const res = await new HttpClient({ retry: false }).send({ url: 'http://127.0.0.1:1' });

    expect(res.success).toBe(false);
    expect((res.reason as HttpResponse).code).toBe('ECONNREFUSED');
    expect((res.reason as HttpResponse).status).toBeUndefined();
  });

  it('rejects invalid retry options', () => {
    expect(() => new HttpClient({ retry: { maxRetries: -1 } })).toThrow('maxRetries');
    expect(() => new HttpClient({ retry: { initialDelayMs: -5 } })).toThrow('initialDelayMs');
  });

  describe('circuit breaker', () => {
    const breaker = { threshold: 2, halfOpenAfterMs: 50 };

    it('has no circuit breaker unless configured', () => {
      expect(new HttpClient().circuitState).toBeUndefined();
    });

    it('opens after consecutive service failures and stops sending requests', async () => {
      server.respond(reply(500));
      const client = new HttpClient({ retry: false, circuitBreaker: breaker });

      await client.send({ url: server.url });
      await client.send({ url: server.url });
      const res = await client.send({ url: server.url });

      expect(client.circuitState).toBe(CircuitState.Open);
      expect(res.reason).toMatchObject({ code: CIRCUIT_OPEN });
      expect(server.requests).toHaveLength(2);
    });

    it('is not opened by client errors', async () => {
      server.respond(reply(404));
      const client = new HttpClient({ retry: false, circuitBreaker: breaker });

      for (let i = 0; i < 4; i++) await client.send({ url: server.url });

      expect(client.circuitState).toBe(CircuitState.Closed);
      expect(server.requests).toHaveLength(4);
    });

    it('closes again after a successful trial request', async () => {
      server.respond(reply(500), reply(500), reply(200));
      const client = new HttpClient({ retry: false, circuitBreaker: breaker });
      await client.send({ url: server.url });
      await client.send({ url: server.url });
      expect(client.circuitState).toBe(CircuitState.Open);

      await sleep(breaker.halfOpenAfterMs + 20);
      const res = await client.send({ url: server.url });

      expect(res.success).toBe(true);
      expect(client.circuitState).toBe(CircuitState.Closed);
    });

    it('keeps recovering after a failed trial request', async () => {
      server.respond(reply(500), reply(500), reply(500), reply(200));
      const client = new HttpClient({ retry: false, circuitBreaker: breaker });
      await client.send({ url: server.url });
      await client.send({ url: server.url });

      await sleep(breaker.halfOpenAfterMs + 20);
      await client.send({ url: server.url }); // failed trial: open again
      expect(client.circuitState).toBe(CircuitState.Open);

      await sleep(breaker.halfOpenAfterMs + 20);
      const res = await client.send({ url: server.url });

      expect(res.success).toBe(true);
      expect(client.circuitState).toBe(CircuitState.Closed);
      expect(server.requests).toHaveLength(4);
    });

    it('does not retry while the circuit is open', async () => {
      server.respond(reply(503));
      const client = new HttpClient({ retry: { ...fastRetry, maxRetries: 5 }, circuitBreaker: breaker });

      const res = await client.send({ url: server.url });

      expect(res.reason).toMatchObject({ code: CIRCUIT_OPEN });
      expect(server.requests).toHaveLength(2);
    });
  });
});

describe('ServiceRequester', () => {
  afterEach(() => vi.restoreAllMocks());

  it('propagates the current request context (x-request-id and traceparent)', async () => {
    server.respond(reply(200));
    const requester = new ServiceRequester('users', { baseURL: server.url });
    const traceId = 'd'.repeat(32);

    await runWithContext({ requestId: 'req-ctx', traceId }, () => requester.httpCall({ url: '/' }));

    expect(server.requests[0].headers['x-request-id']).toBe('req-ctx');
    expect(parseTraceparent(server.requests[0].headers.traceparent as string)).toBe(traceId);
  });

  it('sends x-request-id and x-source headers and resolves relative URLs against baseURL', async () => {
    server.respond(reply(200, { id: 1 }));
    const requester = new ServiceRequester('users', { baseURL: server.url, source: 'orders-api' });

    const res = await requester.httpCall<{ id: number }>({ url: '/users/1', ref: 'ref-123' });

    expect(res).toMatchObject({ success: true, data: { id: 1 } });
    expect(server.requests[0].url).toBe('/users/1');
    expect(server.requests[0].headers).toMatchObject({ 'x-request-id': 'ref-123', 'x-source': 'orders-api' });
  });

  it('defaults x-source to APP_NAME and drops date/connection response headers', async () => {
    server.respond(reply(200, {}, { 'x-custom': 'yes' }));
    const requester = new ServiceRequester('users', { baseURL: server.url });

    const res = await requester.httpCall({ url: '/' });

    expect(server.requests[0].headers['x-source']).toBe(config.get('APP_NAME'));
    expect(res.headers).toMatchObject({ 'x-custom': 'yes' });
    expect(res.headers).not.toHaveProperty('date');
    expect(res.headers).not.toHaveProperty('connection');
  });

  it('returns the downstream error message and status on failure', async () => {
    server.respond(reply(422, { message: 'invalid email', field: 'email' }));
    const requester = new ServiceRequester('users', { baseURL: server.url });

    const res = await requester.httpCall({ url: '/users', method: 'POST', data: {} });

    expect(res).toMatchObject({
      success: false,
      reason: { status: 422, message: 'invalid email', data: { field: 'email' } },
    });
  });

  it('logs calls without headers or bodies', async () => {
    server.respond(reply(200, { secretBody: 'personal-data' }));
    const info = vi.spyOn(logger, 'info');
    const requester = new ServiceRequester('users', { baseURL: server.url });

    await requester.httpCall({ url: '/me', headers: { authorization: 'Bearer secret-token' }, ref: 'r1' });

    const logged = JSON.stringify(info.mock.calls);
    expect(logged).toContain('users request');
    expect(logged).not.toContain('secret-token');
    expect(logged).not.toContain('personal-data');
  });

  it('shares one circuit breaker across calls (enabled by default)', async () => {
    server.respond(reply(500));
    const requester = new ServiceRequester('users', {
      baseURL: server.url,
      retry: false,
      circuitBreaker: { threshold: 2 },
    });

    await requester.httpCall({ url: '/a' });
    await requester.httpCall({ url: '/b' });
    const res = await requester.httpCall({ url: '/c' });

    expect(requester.circuitState).toBe(CircuitState.Open);
    expect(res.reason).toMatchObject({ code: CIRCUIT_OPEN });
    expect(server.requests).toHaveLength(2);
  });
});
