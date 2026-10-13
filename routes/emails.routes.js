import { Router } from 'express';
import {
  getFiles,
  getMailbox,
  getThreadById,
  getThreads,
  postAssist,
  postAttachment,
  postClassify,
  postDraft,
  postFileSummary,
  postSend,
  postSync,
  postWrite,
} from '../controllers/emails.controller.js';
import { authorize } from '../middleware/authorize.js';
import { createAiLimiter } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import { idParams } from '../validation/common.js';
import { singleFileUpload } from '../middleware/upload.js';
import { MAX_UPLOAD_BYTES } from '../services/emailFiles.service.js';
import {
  accountFilesQuery,
  assistBody,
  draftBody,
  fileSummaryBody,
  listThreadsQuery,
  sendEmailBody,
  writeWithAiBody,
} from '../validation/emails.js';

// Customer mail (/api/emails). authorize() answers "may this person use mail at all"; which
// conversation exactly is decided in the service (one's own mailbox; linked ones for the
// manager line).
const router = Router();
const FEATURE = 'email';
const byId = validate({ params: idParams });
const aiLimiter = createAiLimiter();

router.use(requireAuth);
router.get('/mailbox', authorize(FEATURE, 'view'), getMailbox);
router.post('/sync', authorize(FEATURE, 'view'), postSync);
router.get(
  '/threads',
  authorize(FEATURE, 'view'),
  validate({ query: listThreadsQuery }),
  getThreads,
);
router.get('/threads/:id', authorize(FEATURE, 'view'), byId, getThreadById);
router.post('/send', authorize(FEATURE, 'create'), validate({ body: sendEmailBody }), postSend);
router.post(
  '/attachments',
  authorize(FEATURE, 'create'),
  singleFileUpload({ maxBytes: MAX_UPLOAD_BYTES }),
  postAttachment,
);
router.get('/files', authorize(FEATURE, 'view'), validate({ query: accountFilesQuery }), getFiles);
router.post(
  '/write',
  authorize(FEATURE, 'create'),
  aiLimiter,
  validate({ body: writeWithAiBody }),
  postWrite,
);
router.post(
  '/threads/:id/assist',
  authorize(FEATURE, 'view'),
  aiLimiter,
  validate({ params: idParams, body: assistBody }),
  postAssist,
);
router.post(
  '/files/summary',
  authorize(FEATURE, 'view'),
  aiLimiter,
  validate({ body: fileSummaryBody }),
  postFileSummary,
);
router.post('/threads/:id/classify', authorize(FEATURE, 'view'), aiLimiter, byId, postClassify);
router.post(
  '/threads/:id/draft',
  authorize(FEATURE, 'create'),
  aiLimiter,
  validate({ params: idParams, body: draftBody }),
  postDraft,
);

export default router;
