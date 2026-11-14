import express, { Router } from 'express';
import { TRANSCRIPT_SETTINGS } from '../config/meetingTranscripts.js';
import {
  getLiveTranscript,
  getMeetingMatch,
  getMyRecorders,
  getRecorderAccounts,
  getRecorderLeads,
  getRecorderMe,
  postDisconnect,
  postPair,
  postPairingCode,
  postRecording,
  postSegment,
  postStop,
  removeRecorder,
} from '../controllers/recorder.controller.js';
import { authorize } from '../middleware/authorize.js';
import { createLoginLimiter } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireRecorder } from '../middleware/requireRecorder.js';
import { validate } from '../middleware/validate.js';
import { listAccountsQuery } from '../validation/accounts.js';
import { listLeadsQuery } from '../validation/opportunities.js';
import {
  deviceParams,
  meetingForCodeQuery,
  pairBody,
  recordingParams,
  segmentQuery,
  startRecordingBody,
  stopRecordingBody,
} from '../validation/recorder.js';

// The meeting recorder (Chrome extension; docs/MEETING_RECORDER.md), under /api/recorder.
//   - /devices, /pairing-codes: in the CRM, signed in with the session (requireAuth)
//   - /pair: the extension trades a one-time code for its token (no sign-in, rate limited)
//   - everything else: the extension, with its token (requireRecorder)
// Which meeting, company and lead a person may use is decided in the services, as everywhere.
const router = Router();

router.get('/devices', requireAuth, getMyRecorders);
router.post('/pairing-codes', requireAuth, postPairingCode);
router.delete(
  '/devices/:deviceId',
  requireAuth,
  validate({ params: deviceParams }),
  removeRecorder,
);

// Like a sign-in: a few tries per address, so a code cannot be guessed.
router.post('/pair', createLoginLimiter({ limit: 10 }), validate({ body: pairBody }), postPair);

router.get('/me', requireRecorder, getRecorderMe);
router.post('/disconnect', requireRecorder, postDisconnect);
router.get(
  '/meetings/match',
  requireRecorder,
  authorize('meetings', 'view'),
  validate({ query: meetingForCodeQuery }),
  getMeetingMatch,
);
router.get(
  '/accounts',
  requireRecorder,
  authorize('accounts', 'view'),
  validate({ query: listAccountsQuery }),
  getRecorderAccounts,
);
router.get(
  '/leads',
  requireRecorder,
  authorize('opportunities', 'view'),
  validate({ query: listLeadsQuery }),
  getRecorderLeads,
);
router.post(
  '/recordings',
  requireRecorder,
  authorize('meetings', 'view'),
  validate({ body: startRecordingBody }),
  postRecording,
);
router.post(
  '/recordings/:recordingId/segments',
  requireRecorder,
  authorize('meetings', 'view'),
  express.raw({ type: 'audio/wav', limit: TRANSCRIPT_SETTINGS.maxSegmentBytes }),
  validate({ params: recordingParams, query: segmentQuery }),
  postSegment,
);
router.post(
  '/recordings/:recordingId/stop',
  requireRecorder,
  validate({ params: recordingParams, body: stopRecordingBody }),
  postStop,
);
router.get(
  '/recordings/:recordingId/transcript',
  requireRecorder,
  validate({ params: recordingParams }),
  getLiveTranscript,
);

export default router;
