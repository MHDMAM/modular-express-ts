import { Router } from 'express';
import HealthController from './controller';
let router = Router();

router.route('/health').get(HealthController.check);

export default router;
