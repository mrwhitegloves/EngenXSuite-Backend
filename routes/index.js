import { Router } from 'express';
import healthRoutes from './health.routes.js';
import authRoutes from './auth.routes.js';
import publicRoutes from './public.routes.js';
import usersRoutes from './users.routes.js';
import rolesRoutes from './roles.routes.js';

// Every API route file is mounted here, under /api. Add one line per feature.
const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/public', publicRoutes);
router.use('/users', usersRoutes);
router.use('/roles', rolesRoutes);

export default router;
