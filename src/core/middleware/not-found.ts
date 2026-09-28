import { HttpException } from '#core/errors';
import { NextFunction, Request, Response } from 'express';

const notFoundMiddleware = (req: Request, res: Response, next: NextFunction) => {
  return next(HttpException.notFound());
};

export default notFoundMiddleware;
