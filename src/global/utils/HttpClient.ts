import { SuccessPromiseObj } from '@lTypes/interfaces';
import CircuitBreaker from '@utils/CircuitBreaker'; // Ensure to import the CircuitBreaker class
import axios, { AxiosError, AxiosRequestConfig, AxiosResponse } from 'axios';
import _ from 'lodash';

export { AxiosRequestConfig };

/**
 * Specifies how failing HTTP requests should be retried.
 */
export interface RetryConfig {
  /** Maximum number of times to retry a given request. */
  maxRetries: number;

  /** HTTP status codes that should be retried. */
  statusCodes?: number[];

  /** Low-level I/O error codes that should be retried. */
  ioErrorCodes?: string[];

  /**
   * The multiplier for exponential back off. When the backOffFactor is set to 0, retries are not delayed.
   * When the backOffFactor is 1, retry duration is doubled each iteration.
   */
  backOffFactor?: number;

  /** Maximum duration to wait before initiating a retry. */
  maxDelayInMillis: number;
}

/**
 * Default retry configuration for HTTP requests.
 * Retries up to 4 times on connection reset and timeout errors as well as HTTP 503 errors.
 */
export function defaultRetryConfig(): RetryConfig {
  return {
    maxRetries: 4,
    statusCodes: [503],
    ioErrorCodes: ['ECONNRESET', 'ETIMEDOUT'],
    backOffFactor: 0.5,
    maxDelayInMillis: 60 * 1000,
  };
}

/**
 * Ensures that the given RetryConfig object is valid.
 *
 * @param retry The configuration to be validated.
 */
function validateRetryConfig(retry: RetryConfig) {
  if (!_.isNumber(retry.maxRetries) || retry.maxRetries < 0) {
    throw new Error('maxRetries must be a non-negative integer');
  }

  if (typeof retry.backOffFactor !== 'undefined') {
    if (!_.isNumber(retry.backOffFactor) || retry.backOffFactor < 0) {
      throw new Error('backOffFactor must be a non-negative number');
    }
  }

  if (!_.isNumber(retry.maxDelayInMillis) || retry.maxDelayInMillis < 0) {
    throw new Error('maxDelayInMillis must be a non-negative integer');
  }

  if (typeof retry.statusCodes !== 'undefined' && !Array.isArray(retry.statusCodes)) {
    throw new Error('statusCodes must be an array');
  }

  if (typeof retry.ioErrorCodes !== 'undefined' && !Array.isArray(retry.ioErrorCodes)) {
    throw new Error('ioErrorCodes must be an array');
  }
}

/**
 * Represents an HTTP response received from a remote server.
 */
export interface HttpResponse {
  /** HTTP status code. */
  readonly status: number;

  /** HTTP headers returned from the server. */
  //   readonly headers: Record<string, string | string[]>;
  readonly headers: { [key: string]: any };

  /** HTTP error code like: ETIMEDOUT, ECONNRESET. */
  readonly code?: string;

  /** The request was made, and the server responded with a status code that falls out of the range of 2xx. */
  readonly data: any;

  /** Error message, if any. */
  readonly message: string;

  /** Indicates if the request was made but no response was received. */
  readonly requestMadeNoResponse: boolean;
}

/**
 * A class to handle HTTP requests with retry and optional Circuit Breaker capabilities.
 */
export class HttpClient {
  private circuitBreaker?: CircuitBreaker;

  constructor(
    private readonly retry: RetryConfig = defaultRetryConfig(),
    circuitBreaker?: CircuitBreaker, // Optional CircuitBreaker
  ) {
    this.circuitBreaker = circuitBreaker;
    if (this.retry) {
      validateRetryConfig(this.retry);
    }
  }

  // Private method to send HTTP requests
  private async sendHttpRequest(options: AxiosRequestConfig): Promise<AxiosResponse> {
    return axios(options);
  }

  /**
   * Sends an HTTP request to a remote server.
   *
   * @param {AxiosRequestConfig} config HTTP request to be sent.
   * @return {Promise<SuccessPromiseObj>} A promise that resolves with the response details.
   */
  public async send(config: AxiosRequestConfig): Promise<SuccessPromiseObj> {
    if (this.circuitBreaker) {
      return this.handleWithCircuitBreaker(config);
    } else {
      return this.handleWithoutCircuitBreaker(config);
    }
  }

  private async handleWithCircuitBreaker(config: AxiosRequestConfig): Promise<SuccessPromiseObj> {
    return await this.circuitBreaker!.call(() => this.handleWithoutCircuitBreaker(config));
    // try {
    //   // Attempt to make the HTTP request with the circuit breaker
    //   const result: AxiosResponse = await this.circuitBreaker!.call(() => this.sendHttpRequest(config));
    //   // If successful, build and return the successPromiseObj
    //   const _response: HttpResponse = {
    //     data: result.data,
    //     status: result.status,
    //     headers: result.headers,
    //     message: 'Success',
    //     requestMadeNoResponse: false,
    //   };

    //   return { success: true, data: _response };
    // } catch (error) {
    //   // Handle the error and return a successPromiseObj
    //   const errorResponse = this.handleAxiosError(error as AxiosError);

    //   return errorResponse;
    // }
  }

  private async handleWithoutCircuitBreaker(config: AxiosRequestConfig): Promise<SuccessPromiseObj> {
    try {
      // Make the HTTP request
      const result: AxiosResponse = await this.sendHttpRequest(config);

      // If the request is successful, build and return the successPromiseObj
      const _response: HttpResponse = {
        data: result.data,
        status: result.status,
        headers: result.headers,
        message: 'Success',
        requestMadeNoResponse: false,
      };
      return { success: true, data: _response };
    } catch (error) {
      // If an error occurs, handle it and return a successPromiseObj with error details
      return this.handleAxiosError(error as AxiosError);
    }
  }

  // Helper method to handle Axios errors and return consistent error response
  private handleAxiosError(error: AxiosError): SuccessPromiseObj {
    const response: SuccessPromiseObj = { success: false };

    const reason: HttpResponse = {
      data: error.response?.data,
      status: error.response?.status,
      headers: error.response?.headers,
      code: error.code,
      message: error.message,
      requestMadeNoResponse: !!error.request,
    };
    response.reason = reason;
    return response;
  }

  /**
   * Parses the Retry-After HTTP header as a milliseconds value.
   */
  private parseRetryAfterIntoMillis(retryAfter: string): number {
    const delaySeconds: number = parseInt(retryAfter, 10);
    if (!isNaN(delaySeconds)) {
      return delaySeconds * 1000;
    }

    const date = new Date(retryAfter);
    if (!isNaN(date.getTime())) {
      return date.getTime() - Date.now();
    }
    return -1;
  }

  /**
   * Wait for a given amount of milliseconds before retrying the request.
   */
  private async waitForRetry(delayMillis: number): Promise<void> {
    if (delayMillis > 0) {
      return new Promise((resolve) => setTimeout(resolve, delayMillis));
    }
  }

  /**
   * Calculates backoff delay based on the retry attempt count.
   */
  private backOffDelayMillis(retryAttempts: number): number {
    if (retryAttempts === 0) {
      return 0;
    }

    const delayMillis = Math.min(
      2 ** retryAttempts * (this.retry.backOffFactor || 0) * 1000,
      this.retry.maxDelayInMillis,
    );
    return delayMillis;
  }

  /**
   * Determines if a failed request can be retried and returns the delay before the retry.
   */
  private getRetryDelayMillis(retryAttempts: number, err: AxiosError): [number, boolean] {
    if (!this.isRetryEligible(retryAttempts, err)) {
      return [0, false];
    }

    const response = err.response;
    const headers = response ? response.headers : undefined;
    let retryAfter: string | undefined;

    if (headers && typeof headers['retry-after'] === 'string') {
      retryAfter = headers['retry-after'];
    } else if (headers && Array.isArray(headers['retry-after'])) {
      retryAfter = headers['retry-after'][0]; // Take the first value if there are multiple
    }

    if (retryAfter) {
      const delayMillis = this.parseRetryAfterIntoMillis(retryAfter);
      if (delayMillis > 0) {
        return [delayMillis, true];
      }
    }

    return [this.backOffDelayMillis(retryAttempts), true];
  }

  /**
   * Checks if a failed request is eligible for retrying.
   */
  private isRetryEligible(retryAttempts: number, err: AxiosError): boolean {
    if (retryAttempts >= this.retry.maxRetries) {
      return false;
    }

    if (err.response) {
      return this.retry.statusCodes?.includes(err.response.status) || false;
    }

    return this.retry.ioErrorCodes?.includes(err.code) || false;
  }
}
