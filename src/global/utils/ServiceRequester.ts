import { SuccessPromiseObj } from '@lTypes/interfaces';
import { AxiosRequestConfig, HttpClient } from '@utils/HttpClient';
import logger from '@utils/logger';
import _ from 'lodash';

interface AxiosRequestConfigCustom extends AxiosRequestConfig {
  ref?: string;
}
export default class ServiceRequester {
  private serviceName: string;
  private timeout: number;
  private source: string;

  constructor(serviceName: string, source: string, timeout: number = 5000) {
    this.serviceName = serviceName;
    this.timeout = timeout;
    this.source = source;
  }
  /**
   * Utility to build Axios request options with common configurations
   */
  public buildRequestOptions(
    options: AxiosRequestConfig,
    ref: string,
    additionalHeaders: Record<string, string> = {},
  ): AxiosRequestConfig {
    const timeout = this.timeout;
    const commonHeaders = { 'x-source': this.source, 'x-request-id': ref };

    return {
      ...options,
      timeout,
      headers: {
        ...options.headers,
        ...commonHeaders,
        ...additionalHeaders, // Add any additional headers if needed
      },
    };
  }

  // Helper method to handle HTTP response
  private async handleHttpResponse<T, H = any>(resp: SuccessPromiseObj): Promise<SuccessPromiseObj<T>> {
    if (resp.success) {
      return {
        success: resp.success,
        data: resp.data.data as T,
        headers: _.omit(resp.data.headers, ['date', 'connection']) as H,
      };
    } else {
      // Create and return a new SuccessPromiseObj with success: false
      return {
        success: false,
        reason: {
          status: resp.reason?.status,
          message: resp.reason?.data || resp.reason?.data?.message,
          code: resp.reason?.code,
        },
      };
    }
  }

  // Reusable HTTP call method
  async httpCall<T, H = any>(options: AxiosRequestConfigCustom): Promise<SuccessPromiseObj<T>> {
    const httpClient = new HttpClient(); // HttpClient instance without config
    const requestConfig: AxiosRequestConfigCustom = {
      ...options,
      timeout: options.timeout || this.timeout, // Ensure timeout is included
    };

    const start = process.hrtime.bigint();
    const response: SuccessPromiseObj = await httpClient.send(requestConfig);
    const end = process.hrtime.bigint();
    const benchmark = Number((end - start) / 1000000n);

    // Logging request/response details with benchmark timing
    logger.info({
      info: `${this.serviceName} Request/Response Details`,
      request: _.omit(requestConfig, ['httpsAgent']),
      response,
      benchmark,
      ref: options.ref,
    });

    return await this.handleHttpResponse<T, H>(response); // Pass the response to handleHttpResponse
  }
}
