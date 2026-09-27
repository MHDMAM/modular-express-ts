import { SUCCESS_STATUS } from '@utils/HttpException';
import logger from '@utils/logger';
import { contextFromHeaders, runWithContext } from '@utils/requestContext';
import { NextFunction, Request, Response } from 'express';
import { MetaData } from './express';

/**
 * First middleware of every request: creates the request context (`x-request-id` / `traceparent`, generated when
 * missing), runs the rest of the request inside it, and logs the start and end of the request.
 * Headers and bodies are not logged: they may carry credentials or personal data.
 */
export const requestLogger = (req: Request, res: Response, next: NextFunction) => {
  const context = contextFromHeaders(req.headers);
  req.benchmark = process.hrtime.bigint();
  req.ref = context.requestId;
  req.requestTime = Date.now();
  res.set('x-request-id', context.requestId);

  // next() must run inside the context so every downstream middleware and handler sees it
  runWithContext(context, () => {
    logger.info({ info: 'Request started', method: req.method, path: req.originalUrl });

    const send = res.send;
    res.send = function (response) {
      res.send = send;
      const benchmark = Number((process.hrtime.bigint() - req.benchmark) / 1000000n);
      req.responseTime = Date.now();
      const metadata: MetaData = {
        requestTime: req.requestTime,
        responseTime: req.responseTime,
        processingTime: benchmark,
      };

      if (typeof response === 'object' && response !== null) {
        response._metadata = metadata;
        if (!response.status) response.status = SUCCESS_STATUS;
      }

      logger.info({
        info: 'Request completed',
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        benchmark,
      });
      return res.send(response);
    };

    next();
  });
};
export default requestLogger;
