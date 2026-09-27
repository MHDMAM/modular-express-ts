import { SuccessPromiseObj } from '@lTypes/interfaces';
import axios, { AxiosError, AxiosRequestConfig, AxiosResponse } from 'axios';
import {
  BrokenCircuitError,
  CircuitBreakerPolicy,
  CircuitState,
  ConsecutiveBreaker,
  DelegateBackoff,
  IPolicy,
  IRetryBackoffContext,
  circuitBreaker,
  handleWhen,
  noop,
  retry,
  wrap,
} from 'cockatiel';

export { AxiosRequestConfig, CircuitState };

/** Specifies how failing HTTP requests are retried. */
export interface RetryOptions {
  /** Retries after the first attempt; 0 disables retrying. */
  maxRetries: number;
  /** HTTP status codes that are retried. */
  statusCodes: number[];
  /** Low-level error codes (no response received) that are retried. */
  ioErrorCodes: string[];
  /** Only these methods are retried. Defaults to idempotent methods, so a POST is never sent twice. */
  methods: string[];
  /** Delay before the first retry; doubles on every retry (with jitter). */
  initialDelayMs: number;
  /** Upper bound for any delay, including a `Retry-After` sent by the server. */
  maxDelayMs: number;
}

/** Specifies when the circuit opens. Share one HttpClient per downstream service so the state is shared too. */
export interface CircuitBreakerOptions {
  /** Consecutive failures (5xx, 408, 429 or no response) that open the circuit. */
  threshold: number;
  /** How long the circuit stays open before a trial request is let through. */
  halfOpenAfterMs: number;
}

export interface HttpClientOptions {
  /** Retry settings merged over `DEFAULT_RETRY`; `false` disables retrying. */
  retry?: Partial<RetryOptions> | false;
  /** Circuit breaker settings merged over `DEFAULT_CIRCUIT_BREAKER`; disabled unless given. */
  circuitBreaker?: Partial<CircuitBreakerOptions> | false;
}

export const DEFAULT_RETRY: RetryOptions = {
  maxRetries: 3,
  statusCodes: [408, 429, 502, 503, 504],
  ioErrorCodes: ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN', 'EPIPE'],
  methods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'],
  initialDelayMs: 200,
  maxDelayMs: 10_000,
};

export const DEFAULT_CIRCUIT_BREAKER: CircuitBreakerOptions = { threshold: 5, halfOpenAfterMs: 30_000 };

/** Error code returned while the circuit is open (the request is not sent). */
export const CIRCUIT_OPEN = 'ECIRCUITOPEN';

/** Represents an HTTP response received from a remote server, or the reason none was received. */
export interface HttpResponse {
  /** HTTP status code, when a response was received. */
  readonly status?: number;
  readonly headers?: Record<string, any>;
  /** Error code like ETIMEDOUT, ECONNRESET or ECIRCUITOPEN. */
  readonly code?: string;
  readonly data?: any;
  readonly message: string;
  /** The request was sent but no response was received. */
  readonly requestMadeNoResponse: boolean;
}

/** Parses a `Retry-After` header (seconds or HTTP date) into milliseconds. */
export function retryAfterMs(headers?: Record<string, any>): number | undefined {
  const raw = headers?.['retry-after'];
  const value: string | undefined = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null || value === '') return undefined;

  const seconds = Number(value);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** Exponential backoff with "equal jitter": half of the delay is fixed, half is random. */
export function backoffDelayMs(attempt: number, initialDelayMs: number, maxDelayMs: number, random = Math.random) {
  const base = Math.min(maxDelayMs, initialDelayMs * 2 ** Math.max(0, attempt - 1));
  return base / 2 + (random() * base) / 2;
}

function validateRetryOptions(retry: RetryOptions) {
  if (!Number.isInteger(retry.maxRetries) || retry.maxRetries < 0) {
    throw new Error('retry.maxRetries must be a non-negative integer');
  }
  if (!(retry.initialDelayMs >= 0)) throw new Error('retry.initialDelayMs must be a non-negative number');
  if (!(retry.maxDelayMs >= 0)) throw new Error('retry.maxDelayMs must be a non-negative number');
}

/** True when the downstream service itself looks unhealthy (as opposed to a bad request). */
function isServiceFailure(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  const status = error.response?.status;
  return status === undefined || status >= 500 || status === 408 || status === 429;
}

function isRetryable(error: unknown, options: RetryOptions): boolean {
  if (!axios.isAxiosError(error)) return false;
  const method = (error.config?.method ?? 'get').toUpperCase();
  if (!options.methods.includes(method)) return false;
  if (error.response) return options.statusCodes.includes(error.response.status);
  return options.ioErrorCodes.includes(error.code ?? '');
}

function toFailure(error: unknown): HttpResponse {
  if (error instanceof BrokenCircuitError) {
    return { code: CIRCUIT_OPEN, message: 'Circuit is open, request not sent', requestMadeNoResponse: false };
  }
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError;
    return {
      status: axiosError.response?.status,
      headers: axiosError.response?.headers,
      data: axiosError.response?.data,
      code: axiosError.code,
      message: axiosError.message,
      requestMadeNoResponse: !!axiosError.request && !axiosError.response,
    };
  }
  return { message: error instanceof Error ? error.message : String(error), requestMadeNoResponse: false };
}

/**
 * Sends HTTP requests with retries and an optional circuit breaker. Never throws: failures are returned as
 * `{ success: false, reason }`.
 */
export class HttpClient {
  private readonly policy: IPolicy;
  private readonly breaker?: CircuitBreakerPolicy;

  constructor(options: HttpClientOptions = {}) {
    const policies: IPolicy[] = [];

    if (options.retry !== false) {
      const retryOptions: RetryOptions = { ...DEFAULT_RETRY, ...options.retry };
      validateRetryOptions(retryOptions);
      retryOptions.methods = retryOptions.methods.map((m) => m.toUpperCase());
      policies.push(
        retry(
          handleWhen((error) => isRetryable(error, retryOptions)),
          {
            maxAttempts: retryOptions.maxRetries,
            backoff: new DelegateBackoff((context: IRetryBackoffContext<unknown>) => {
              const error = 'error' in context.result ? context.result.error : undefined;
              const serverDelay = axios.isAxiosError(error) ? retryAfterMs(error.response?.headers) : undefined;
              const delay =
                serverDelay ?? backoffDelayMs(context.attempt, retryOptions.initialDelayMs, retryOptions.maxDelayMs);
              return Math.min(delay, retryOptions.maxDelayMs);
            }),
          },
        ),
      );
    }

    if (options.circuitBreaker) {
      const breakerOptions: CircuitBreakerOptions = { ...DEFAULT_CIRCUIT_BREAKER, ...options.circuitBreaker };
      this.breaker = circuitBreaker(handleWhen(isServiceFailure), {
        halfOpenAfter: breakerOptions.halfOpenAfterMs,
        breaker: new ConsecutiveBreaker(breakerOptions.threshold),
      });
      policies.push(this.breaker);
    }

    // Retry wraps the breaker: every attempt is counted by the breaker, and an open circuit is not retried
    this.policy = policies.length ? wrap(...policies) : noop;
  }

  /** Current circuit state, or `undefined` when the client has no circuit breaker. */
  get circuitState(): CircuitState | undefined {
    return this.breaker?.state;
  }

  /** Sends an HTTP request. Resolves with the response, or with the failure reason after retries are exhausted. */
  public async send(config: AxiosRequestConfig): Promise<SuccessPromiseObj<HttpResponse>> {
    try {
      const result: AxiosResponse = await this.policy.execute(({ signal }) =>
        axios({ ...config, signal: config.signal ?? signal }),
      );
      return {
        success: true,
        data: {
          data: result.data,
          status: result.status,
          headers: result.headers,
          message: 'Success',
          requestMadeNoResponse: false,
        },
      };
    } catch (error) {
      return { success: false, reason: toFailure(error) };
    }
  }
}
