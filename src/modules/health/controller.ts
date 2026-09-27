import { NextFunction, Request, Response } from 'express';

export default class HealthController {
  static check(req: Request, res: Response, next: NextFunction) {
    return res.send({ payload: { healthy: true, uptime: process.uptime() } });
  }
}
