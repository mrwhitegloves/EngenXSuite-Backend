import { Router } from 'express';
import {
  getFormOptions,
  getMeetingById,
  getMeetings,
  getRecord,
  patchMeeting,
  postClose,
  postDecideTask,
  postFile,
  postMeeting,
  postSummary,
  postSync,
  postTranscribe,
} from '../controllers/meetings.controller.js';
import { authorize } from '../middleware/authorize.js';
import { createAiLimiter } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { singleFileUpload } from '../middleware/upload.js';
import { MAX_MEETING_FILE_BYTES } from '../services/meetingSummaries.service.js';
import { validate } from '../middleware/validate.js';
import { idParams } from '../validation/common.js';
import {
  closeMeetingBody,
  createMeetingBody,
  decideTaskBody,
  listMeetingsQuery,
  transcribeBody,
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

// What is kept after the meeting: files, the AI's summary, the tasks it proposes.
const byId = validate({ params: idParams });
const aiLimiter = createAiLimiter();
router.get('/:id/record', authorize(FEATURE, 'view'), byId, getRecord);
router.post('/:id/summary', authorize(FEATURE, 'edit'), aiLimiter, byId, postSummary);
router.post(
  '/:id/summary/tasks',
  authorize(FEATURE, 'edit'),
  validate({ params: idParams, body: decideTaskBody }),
  postDecideTask,
);
router.post(
  '/:id/files',
  authorize(FEATURE, 'edit'),
  byId,
  singleFileUpload({ maxBytes: MAX_MEETING_FILE_BYTES }),
  postFile,
);
router.post(
  '/:id/files/transcribe',
  authorize(FEATURE, 'edit'),
  aiLimiter,
  validate({ params: idParams, body: transcribeBody }),
  postTranscribe,
);

export default router;
