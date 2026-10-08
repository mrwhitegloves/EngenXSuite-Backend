import { Router } from 'express';
import healthRoutes from './health.routes.js';

// Every API route file is mounted here, under /api. Add one line per feature.
const router = Router();

router.use('/health', healthRoutes);

export default router;
