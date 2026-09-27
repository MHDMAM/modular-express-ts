import { HttpException } from '@core/errors';
import logger from '@core/logger';
import { NextFunction, Request, Response } from 'express';
import _ from 'lodash';
import { MetaData } from './request-logger';

const errorMiddleware = (err: Error, req: Request, res: Response, next: NextFunction) => {
  let error = err as HttpException;
  if (!req.benchmark) req.benchmark = 0n;

  const benchmark = Number((process.hrtime.bigint() - req.benchmark) / 1000000n);

  const metadata: MetaData = {
    requestTime: req.requestTime,
    responseTime: req.responseTime,
    processingTime: benchmark,
  };
  // Headers and bodies are not logged: they may carry credentials or personal data
  logger.error({
    info: 'Request failed',
    method: req.method,
    path: req.originalUrl,
    httpStatus: error.httpCode,
    status: error.status,
    benchmark,
    error,
  });

  // Invalid JSON body (thrown by express.json()) or any error that is not an HttpException
  if (!(err instanceof HttpException)) {
    const isInvalidJson = err instanceof SyntaxError && (err as any).status === 400 && 'body' in err;
    error = isInvalidJson ? HttpException.invalidPayload() : HttpException.internal();
  }

  const response = _.assign({ status: error.status, message: error.message }, error.data);
  response._metadata = metadata;
  return res.status(error.httpCode).send(response);
};

export default errorMiddleware;
