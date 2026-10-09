import { Router } from 'express';
import { getRealtimeTicket } from '../controllers/realtime.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';

// Live updates: any signed-in, active user may open a connection for their own account.
const router = Router();

router.use(requireAuth);

router.get('/ticket', getRealtimeTicket);

export default router;
