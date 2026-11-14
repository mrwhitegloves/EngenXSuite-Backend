import { Router } from 'express';
import {
  postAnalysis,
  getFormOptions,
  getMeetingById,
  getSegmentAudio,
  getTranscript,
  getTranscriptDownload,
  patchSegment,
  removeAnalysis,
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
  removeMeeting,
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
import {
  analysisParams,
  editSegmentBody,
  externalAnalysisBody,
  segmentParams,
  summaryBody,
} from '../validation/recorder.js';

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
router.delete('/:id', authorize(FEATURE, 'delete'), validate({ params: idParams }), removeMeeting);
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
router.post(
  '/:id/summary',
  authorize(FEATURE, 'edit'),
  aiLimiter,
  validate({ params: idParams, body: summaryBody }),
  postSummary,
);
// Analyses made outside the CRM (pasted by a person), next to the AI's summary.
router.post(
  '/:id/analyses',
  authorize(FEATURE, 'view'),
  validate({ params: idParams, body: externalAnalysisBody }),
  postAnalysis,
);
router.delete(
  '/:id/analyses/:analysisId',
  authorize(FEATURE, 'view'),
  validate({ params: analysisParams }),
  removeAnalysis,
);

// The transcript made by the meeting recorder (Chrome extension).
router.get('/:id/transcript', authorize(FEATURE, 'view'), byId, getTranscript);
router.get('/:id/transcript/download', authorize(FEATURE, 'view'), byId, getTranscriptDownload);
router.patch(
  '/:id/transcript/segments/:segmentId',
  authorize(FEATURE, 'view'),
  validate({ params: segmentParams, body: editSegmentBody }),
  patchSegment,
);
router.get(
  '/:id/transcript/segments/:segmentId/audio',
  authorize(FEATURE, 'view'),
  validate({ params: segmentParams }),
  getSegmentAudio,
);
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
