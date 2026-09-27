import { SUCCESS_STATUS } from '@utils/HttpException';
import logger from '@utils/logger';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { MetaData } from './express';

export const requestLogger = (req: Request, res: Response, next: NextFunction) => {
  req.benchmark = process.hrtime.bigint();

  req.ref = req.get('x-request-id') || randomUUID();
  res.set('x-request-id', req.ref);
  req.requestTime = Date.now();
  logger.info({
    msg: 'Start New Request',
    ref: req.ref,
    method: req.method,
    path: req.originalUrl,
    headers: req.headers,
    query: req.query,
    params: req.params,
    body: req.body,
  });

  const Send = res.send;

  res.send = function (response) {
    res.send = Send;
    const end = process.hrtime.bigint();
    const benchmark = Number((end - req.benchmark) / 1000000n);
    req.responseTime = Date.now();
    const metadata: MetaData = {
      requestTime: req.requestTime,
      responseTime: req.responseTime,
      processingTime: benchmark,
    };

    if (typeof response === 'object') response._metadata = metadata;
    if (typeof response === 'object' && !response.status) response.status = SUCCESS_STATUS;

    logger.info({
      msg: 'End Request',
      ref: req.ref,
      method: req.method,
      path: req.originalUrl,
      req_headers: req.headers,
      res_headers: res.getHeaders(),
      query: req.query,
      params: req.params,
      body: req.body,
      statusCode: res.statusCode,
      status: res.status,
      response,
      metadata,
      benchmark: benchmark,
    });

    return res.send(response);
  };

  return next();
};
export default requestLogger;
