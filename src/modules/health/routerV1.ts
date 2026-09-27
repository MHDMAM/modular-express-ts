import { Router } from 'express';
import HealthController from './controller';
let router = Router();

router.route('/health').get(HealthController.check);
router.route('/health/ready').get(HealthController.ready);

export default router;
