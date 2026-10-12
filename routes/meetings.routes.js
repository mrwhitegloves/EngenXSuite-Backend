import { Router } from 'express';
import {
  getFormOptions,
  getMeetingById,
  getMeetings,
  patchMeeting,
  postClose,
  postMeeting,
  postSync,
} from '../controllers/meetings.controller.js';
import { authorize } from '../middleware/authorize.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import { idParams } from '../validation/common.js';
import {
  closeMeetingBody,
  createMeetingBody,
  listMeetingsQuery,
  updateMeetingBody,
} from '../validation/meetings.js';

// Meetings (/api/meetings). authorize() answers "may this person use meetings at all"; which
// meeting exactly is decided in the service (the organizer, the invited, the manager line, and
// everyone who may see the lead or company it is about).
const router = Router();
const FEATURE = 'meetings';

router.use(requireAuth);
router.get('/', authorize(FEATURE, 'view'), validate({ query: listMeetingsQuery }), getMeetings);
router.get('/form-options', authorize(FEATURE, 'view'), getFormOptions);
router.post('/sync', authorize(FEATURE, 'view'), postSync);
router.post('/', authorize(FEATURE, 'create'), validate({ body: createMeetingBody }), postMeeting);
router.get('/:id', authorize(FEATURE, 'view'), validate({ params: idParams }), getMeetingById);
router.patch(
  '/:id',
  authorize(FEATURE, 'edit'),
  validate({ params: idParams, body: updateMeetingBody }),
  patchMeeting,
);
router.post(
  '/:id/close',
  authorize(FEATURE, 'edit'),
  validate({ params: idParams, body: closeMeetingBody }),
  postClose,
);

export default router;
