import { Router } from 'express';
import healthRoutes from './health.routes.js';
import authRoutes from './auth.routes.js';
import publicRoutes from './public.routes.js';
import usersRoutes from './users.routes.js';
import rolesRoutes from './roles.routes.js';
import jobsRoutes from './jobs.routes.js';
import auditRoutes from './audit.routes.js';
import backupsRoutes from './backups.routes.js';
import savedViewsRoutes from './savedViews.routes.js';
import settingsRoutes from './settings.routes.js';
import realtimeRoutes from './realtime.routes.js';
import accountsRoutes from './accounts.routes.js';
import statusListsRoutes from './statusLists.routes.js';

// Every API route file is mounted here, under /api. Add one line per feature.
const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/public', publicRoutes);
router.use('/users', usersRoutes);
router.use('/roles', rolesRoutes);
router.use('/jobs', jobsRoutes);
router.use('/audit-logs', auditRoutes);
router.use('/backups', backupsRoutes);
router.use('/saved-views', savedViewsRoutes);
router.use('/settings', settingsRoutes);
router.use('/realtime', realtimeRoutes);
router.use('/accounts', accountsRoutes);
router.use('/status-lists', statusListsRoutes);

export default router;
