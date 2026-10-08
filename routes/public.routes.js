import { Router } from 'express';
import { getPublicBranding } from '../controllers/public.controller.js';

// Routes that need no sign-in. Keep this list short: every route here is reachable by anyone.
const router = Router();

router.get('/branding', getPublicBranding);

export default router;
