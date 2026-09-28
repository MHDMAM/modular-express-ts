import { Request, Response, Router } from 'express';

import config from '#config';

let router = Router();

router.route('/').get((req: Request, res: Response) => {
  return res.send(`Welcome to ${config.appName} API! version 1.0 - ${config.env}`);
});

export default router;
