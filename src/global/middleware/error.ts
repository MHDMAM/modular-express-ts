import { HttpException } from '@utils/HttpException';
import logger from '@utils/logger';
import { NextFunction, Request, Response } from 'express';
import _ from 'lodash';
import { MetaData } from './express';

const errorMiddleware = (err: Error, req: Request, res: Response, next: NextFunction) => {
  let error = err as HttpException;
  if (!req.benchmark) req.benchmark = 0n;

  const benchmark = Number((process.hrtime.bigint() - req.benchmark) / 1000000n);

  const metadata: MetaData = {
    requestTime: req.requestTime,
    responseTime: req.responseTime,
    processingTime: benchmark,
  };
  logger.error({
    info: `Exception Handler: ${req.ref}`,
    method: req.method,
    path: req.originalUrl,
    headers: req.headers,
    query: req.query,
    params: req.params,
    body: req.body,
    errorData: error.data,
    errorMsg: error.message,
    errorName: error.name,
    errorStack: error.stack,
    httpStatus: error.httpCode,
    benchmark,
    isErrorSyntaxError: error instanceof SyntaxError,
    status: error.status,
    error,
    metadata,
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
