import { Router } from 'express';
import { getPublicBranding, getPublicConfig } from '../controllers/public.controller.js';

// Routes that need no sign-in. Keep this list short: every route here is reachable by anyone.
const router = Router();

router.get('/branding', getPublicBranding);
router.get('/config', getPublicConfig);

export default router;
