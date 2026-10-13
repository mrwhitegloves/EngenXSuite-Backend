import { Router } from 'express';
import {
  getFiles,
  getMailbox,
  getThreadById,
  getThreads,
  patchLink,
  postAssist,
  postAttachment,
  postBringIn,
  postClassify,
  postDraft,
  postFileSummary,
  postSend,
  postSync,
  postWrite,
} from '../controllers/emails.controller.js';
import { createWebhookHandler } from '../controllers/webhooks/receive.js';
import { authorize } from '../middleware/authorize.js';
import { createAiLimiter } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import { idParams } from '../validation/common.js';
import { singleFileUpload } from '../middleware/upload.js';
import { MAX_UPLOAD_BYTES } from '../services/emailFiles.service.js';
import { isValidGmailPushToken, readGmailPush } from '../services/emailPush.service.js';
import {
  accountFilesQuery,
  assistBody,
  bringInBody,
  draftBody,
  fileSummaryBody,
  listThreadsQuery,
  relinkBody,
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
router.patch(
  '/threads/:id/link',
  authorize(FEATURE, 'view'),
  validate({ params: idParams, body: relinkBody }),
  patchLink,
);
router.post(
  '/bring-in',
  authorize(FEATURE, 'create'),
  validate({ body: bringInBody }),
  postBringIn,
);
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

// Push from Gmail (/api/webhooks/google/gmail): Google Pub/Sub says that a mailbox changed.
// No sign-in: the secret in the address is the check. The message carries no mail.
export const googleWebhooksRouter = Router();
googleWebhooksRouter.post(
  '/gmail',
  createWebhookHandler({
    provider: 'gmail_push',
    verify: (req) => isValidGmailPushToken(req.query.token),
    getEventId: (req) => req.body?.message?.messageId,
    getPayload: (req) => readGmailPush(req.body),
  }),
);

export default router;
