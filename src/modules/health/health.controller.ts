import { NextFunction, Request, Response } from 'express';

import { HttpException } from '#core/errors';
import { connectorStatus } from '#core/lifecycle';

export default class HealthController {
  /** Liveness: the process is up and serving requests. */
  static check(req: Request, res: Response, next: NextFunction) {
    return res.send({ payload: { healthy: true, uptime: process.uptime() } });
  }

  /** Readiness: every enabled connector is ready (503 otherwise), e.g. for load balancer / Kubernetes probes. */
  static ready(req: Request, res: Response, next: NextFunction) {
    const connectors = connectorStatus();
    const ready = Object.values(connectors).every((status) => status === 'running');
    if (!ready) return next(HttpException.serviceUnavailable('Not Ready', { payload: { ready, connectors } }));
    return res.send({ payload: { ready, connectors } });
  }
}
