import { Router } from 'express';
import {
  getStatuses,
  patchStatus,
  postStatus,
  putStatusOrder,
  removeStatus,
} from '../controllers/statusLists.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import {
  createStatusBody,
  reorderStatusesBody,
  statusListParams,
  statusParams,
  updateStatusBody,
} from '../validation/statusLists.js';

// The status lists managed in Settings → Statuses. Reading is open to every signed-in user (the
// pickers and filters need the names); changing needs the "settings" permission.
const router = Router();

router.use(requireAuth);

router.get('/:list', validate({ params: statusListParams }), getStatuses);
router.post(
  '/:list',
  authorize('settings', 'edit'),
  validate({ params: statusListParams, body: createStatusBody }),
  postStatus,
);
router.put(
  '/:list/order',
  authorize('settings', 'edit'),
  validate({ params: statusListParams, body: reorderStatusesBody }),
  putStatusOrder,
);
router.patch(
  '/:list/:id',
  authorize('settings', 'edit'),
  validate({ params: statusParams, body: updateStatusBody }),
  patchStatus,
);
router.delete(
  '/:list/:id',
  authorize('settings', 'edit'),
  validate({ params: statusParams }),
  removeStatus,
);

export default router;
