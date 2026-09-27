import { HttpException } from '@utils/HttpException';

export type SuccessPromiseObj<T = any, H = any> = {
  success: boolean;
  headers?: H;
  data?: T;
  reason?: any;
  exception?: HttpException;
};
