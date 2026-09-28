import _ from 'lodash';

import config from '#config';
import logger from '#core/logger';
import { contextHeaders } from '#core/request-context';

import {
  AxiosRequestConfig,
  CircuitState,
  HttpClient,
  HttpClientOptions,
  HttpResponse,
  SuccessPromiseObj,
} from './http-client.js';

export interface ServiceRequesterOptions extends HttpClientOptions {
  /** Prefix for relative request URLs. */
  baseURL?: string;
  /** Sent as the `x-source` header so the downstream service knows the caller. Defaults to `APP_NAME`. */
  source?: string;
  /** Per-attempt timeout; defaults to 5000ms. */
  timeoutMs?: number;
}

export interface ServiceRequestConfig extends AxiosRequestConfig {
  /** Overrides the `x-request-id` taken from the current request context. */
  ref?: string;
}

/**
 * Client for one downstream service: adds `x-request-id` / `traceparent` (from the request context) and `x-source`
 * headers, a timeout, retries and a circuit
 * breaker shared by every call (enabled by default), and logs each call without headers or bodies.
 * Create one instance per downstream service and reuse it.
 */
export default class ServiceRequester {
  private readonly client: HttpClient;
  private readonly source: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly serviceName: string,
    private readonly options: ServiceRequesterOptions = {},
  ) {
    this.source = options.source ?? config.appName;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.client = new HttpClient({
      retry: options.retry,
      circuitBreaker: options.circuitBreaker === undefined ? {} : options.circuitBreaker,
    });
  }

  get circuitState(): CircuitState | undefined {
    return this.client.circuitState;
  }

  async httpCall<T, H = Record<string, unknown>>({
    ref,
    ...request
  }: ServiceRequestConfig): Promise<SuccessPromiseObj<T, H>> {
    const requestConfig: AxiosRequestConfig = {
      baseURL: this.options.baseURL,
      ...request,
      timeout: request.timeout ?? this.timeoutMs,
      headers: {
        ...contextHeaders(),
        ...(request.headers as Record<string, string>),
        'x-source': this.source,
        ...(ref && { 'x-request-id': ref }),
      },
    };

    const start = process.hrtime.bigint();
    const response = await this.client.send(requestConfig);
    const benchmark = Number((process.hrtime.bigint() - start) / 1000000n);

    const result: HttpResponse | undefined = response.success ? response.data : response.reason;
    // Headers and bodies are not logged: they may carry credentials or personal data
    (response.success ? logger.info : logger.warn).call(logger, {
      info: `${this.serviceName} request`,
      ref,
      method: (requestConfig.method ?? 'get').toUpperCase(),
      url: `${requestConfig.baseURL ?? ''}${requestConfig.url ?? ''}`,
      success: response.success,
      status: result?.status,
      code: result?.code,
      benchmark,
    });

    if (response.success) {
      return {
        success: true,
        data: response.data.data as T,
        headers: _.omit(response.data.headers, ['date', 'connection']) as H,
      };
    }
    const reason: HttpResponse = response.reason;
    return {
      success: false,
      reason: {
        status: reason.status,
        code: reason.code,
        message: reason.data?.message ?? reason.message,
        data: reason.data,
      },
    };
  }
}
