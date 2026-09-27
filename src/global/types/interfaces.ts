import { HttpException } from '@core/errors';

export type SuccessPromiseObj<T = any, H = any> = {
  success: boolean;
  headers?: H;
  data?: T;
  reason?: any;
  exception?: HttpException;
};
