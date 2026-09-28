import config from '#config';

const STATUS_PREFIX = config.statusPrefix;
const VERSION_1 = 1;

/**
 * Builds a response status code, e.g. `APP1000` for success or `APP1004` for not found.
 * Format: `<statusPrefix><version><3-digit code>`.
 */
export function formatStatus(code: number): string {
  if (code < 0 || code > 999) {
    throw new Error('Status code must be between 000 and 999');
  }
  return `${STATUS_PREFIX}${VERSION_1}${code.toString().padStart(3, '0')}`;
}

export const SUCCESS_STATUS = formatStatus(0);

export class HttpException extends Error {
  public httpCode: number;
  public message: string;
  public status: string | number;
  public data?: any;

  constructor(httpCode: number, status: string, message?: string, data?: any) {
    super(message);
    this.httpCode = httpCode;
    this.status = status;
    if (message) this.message = message;
    if (data) this.data = data;
    Error.captureStackTrace(this, this.constructor);
  }

  static invalidParameters(message?: string, data?: any) {
    return new HttpException(422, formatStatus(1), message || 'Unprocessable Entity', data);
  }

  static invalidPayload(message?: string, data?: any) {
    return new HttpException(400, formatStatus(2), message || 'Invalid Payload', data);
  }

  static unauthorized(message?: string, data?: any) {
    return new HttpException(401, formatStatus(3), message || 'Unauthorized', data);
  }

  static notFound(message?: string, data?: any) {
    return new HttpException(404, formatStatus(4), message || 'Not Found', data);
  }

  static internal(message?: string, data?: any) {
    return new HttpException(500, formatStatus(5), message || 'Internal Server Error', data);
  }

  static serviceUnavailable(message?: string, data?: any) {
    return new HttpException(503, formatStatus(6), message || 'Service Unavailable', data);
  }
}
