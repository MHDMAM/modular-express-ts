import config from 'config';
import { UUID } from 'crypto';
import { NextFunction, Request, Response, Router } from 'express';

export interface MetaData {
  processingTime?: number;
  requestTime?: number;
  responseTime?: number;
}

// Extending the Express Request type globally in TypeScript
declare global {
  interface BigInt {
    toJSON(): number;
    toString(): string;
  }

  namespace Express {
    export interface Request {
      benchmark: bigint;
      ref: UUID | string;
      requestTime?: number;
      responseTime?: number;
    }
  }
}

let router = Router();

router.route('/').get((req: Request, res: Response, next: NextFunction) => {
  return res.send(`Welcome to ${config.get('APP_NAME')} API! version 1.0 - ${req.app.get('env')} `);
});

export default router;
