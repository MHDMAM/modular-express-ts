import { NextFunction, Request, Response } from 'express';

import { HttpException } from '#core/errors';

const notFoundMiddleware = (req: Request, res: Response, next: NextFunction) => {
  return next(HttpException.notFound());
};

export default notFoundMiddleware;
