import { Router } from 'express';
import {
  getLeads,
  getOverview,
  getSessions,
  getStatus,
} from '../controllers/website.controller.js';
import { authorize } from '../middleware/authorize.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import { websiteListQuery, websiteOverviewQuery } from '../validation/website.js';

// /api/website: the Website screen (feature "website": CEO and Sales Managers by default).
const router = Router();
const FEATURE = 'website';

router.use(requireAuth);
router.get('/status', authorize(FEATURE, 'view'), getStatus);
router.get(
  '/analytics/overview',
  authorize(FEATURE, 'view'),
  validate({ query: websiteOverviewQuery }),
  getOverview,
);
router.get(
  '/analytics/sessions',
  authorize(FEATURE, 'view'),
  validate({ query: websiteListQuery }),
  getSessions,
);
router.get(
  '/analytics/leads',
  authorize(FEATURE, 'view'),
  validate({ query: websiteListQuery }),
  getLeads,
);

export default router;
