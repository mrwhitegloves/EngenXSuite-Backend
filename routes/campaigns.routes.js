import { Router } from 'express';
import {
  getCampaignById,
  getCampaigns,
  getRecipients,
  postBundleFromUnsent,
  postCampaign,
  postPreview,
  postStart,
  postStop,
} from '../controllers/campaigns.controller.js';
import { authorize } from '../middleware/authorize.js';
import { createAiLimiter } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import {
  bundleFromUnsentBody,
  createCampaignBody,
  listCampaignsQuery,
  listRecipientsQuery,
  stopCampaignBody,
} from '../validation/campaigns.js';
import { idParams } from '../validation/common.js';

// Bulk sending (/api/campaigns). The "campaigns" permission answers "may this person send in
// bulk at all"; which sending exactly, and that only its maker starts it, is in the service.
const router = Router();
const FEATURE = 'campaigns';
const byId = validate({ params: idParams });

router.use(requireAuth);
router.get('/', authorize(FEATURE, 'view'), validate({ query: listCampaignsQuery }), getCampaigns);
router.post(
  '/',
  authorize(FEATURE, 'create'),
  validate({ body: createCampaignBody }),
  postCampaign,
);
router.get('/:id', authorize(FEATURE, 'view'), byId, getCampaignById);
router.get(
  '/:id/recipients',
  authorize(FEATURE, 'view'),
  validate({ params: idParams, query: listRecipientsQuery }),
  getRecipients,
);
router.post('/:id/preview', authorize(FEATURE, 'create'), createAiLimiter(), byId, postPreview);
router.post('/:id/start', authorize(FEATURE, 'create'), byId, postStart);
router.post(
  '/:id/stop',
  authorize(FEATURE, 'edit'),
  validate({ params: idParams, body: stopCampaignBody }),
  postStop,
);
router.post(
  '/:id/bundle',
  authorize(FEATURE, 'create'),
  validate({ params: idParams, body: bundleFromUnsentBody }),
  postBundleFromUnsent,
);

export default router;
