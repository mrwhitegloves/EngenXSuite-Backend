import { Router } from 'express';
import { patchBranding } from '../controllers/settings.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { updateBrandingBody } from '../validation/settings.js';

// Product-wide settings. Needs the "settings" permission, which by default only the CEO holds.
const router = Router();

router.use(requireAuth);

router.patch(
  '/branding',
  authorize('settings', 'edit'),
  validate({ body: updateBrandingBody }),
  patchBranding,
);

export default router;
