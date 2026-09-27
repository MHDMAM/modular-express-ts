import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Metadata about the current request (or message), available anywhere in its async call chain without passing it
 * around. Keep it to cross-cutting metadata: business data belongs in normal function arguments.
 */
export interface RequestContext {
  /** Our correlation id: taken from the `x-request-id` header, or generated. */
  requestId: string;
  /** W3C trace id (32 hex chars): taken from the `traceparent` header, or generated. */
  traceId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` (and everything it calls, sync or async) with `context` as the current request context. */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The current request context, or `undefined` outside of a request (e.g. at startup). */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

const TRACEPARENT = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/;
const INVALID_TRACE_ID = '0'.repeat(32);

/** Extracts the trace id from a W3C `traceparent` header, if valid. */
export function parseTraceparent(header: string | undefined): string | undefined {
  const traceId = header?.trim().toLowerCase().match(TRACEPARENT)?.[1];
  return traceId && traceId !== INVALID_TRACE_ID ? traceId : undefined;
}

/** Builds a W3C `traceparent` header for an outgoing call: same trace id, new span id, sampled. */
export function formatTraceparent(traceId: string): string {
  return `00-${traceId}-${randomBytes(8).toString('hex')}-01`;
}

/** Creates a context from incoming headers (HTTP or message headers), generating whatever is missing. */
export function contextFromHeaders(headers: Record<string, string | string[] | undefined>): RequestContext {
  const header = (name: string) => {
    const value = headers[name];
    return (Array.isArray(value) ? value[0] : value) || undefined;
  };
  return {
    requestId: header('x-request-id') ?? randomUUID(),
    traceId: parseTraceparent(header('traceparent')) ?? randomBytes(16).toString('hex'),
  };
}

/** Headers that propagate the current context to a downstream call or message; empty outside of a request. */
export function contextHeaders(): Record<string, string> {
  const context = getRequestContext();
  if (!context) return {};
  return { 'x-request-id': context.requestId, traceparent: formatTraceparent(context.traceId) };
}
