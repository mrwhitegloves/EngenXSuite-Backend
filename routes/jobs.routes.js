import { Router } from 'express';
import {
  getFailedJobs,
  getJobs,
  postRetryJob,
  postTestJob,
  removeJob,
} from '../controllers/jobs.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { failedJobsQuery, jobParams, testJobBody } from '../validation/jobs.js';

// Background jobs (Settings → Background jobs). Needs the "settings" permission, which by
// default only the CEO account type holds.
const router = Router();

router.use(requireAuth);

router.get('/', authorize('settings', 'view'), getJobs);
router.get(
  '/failed',
  authorize('settings', 'view'),
  validate({ query: failedJobsQuery }),
  getFailedJobs,
);
router.post('/test', authorize('settings', 'edit'), validate({ body: testJobBody }), postTestJob);
router.post(
  '/:queue/:jobId/retry',
  authorize('settings', 'edit'),
  validate({ params: jobParams }),
  postRetryJob,
);
router.delete(
  '/:queue/:jobId',
  authorize('settings', 'edit'),
  validate({ params: jobParams }),
  removeJob,
);

export default router;
