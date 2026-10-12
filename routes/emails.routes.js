import { Router } from 'express';
import {
  getMailbox,
  getThreadById,
  getThreads,
  postClassify,
  postDraft,
  postSend,
  postSync,
} from '../controllers/emails.controller.js';
import { authorize } from '../middleware/authorize.js';
import { createAiLimiter } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import { idParams } from '../validation/common.js';
import { draftBody, listThreadsQuery, sendEmailBody } from '../validation/emails.js';

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
router.post('/threads/:id/classify', authorize(FEATURE, 'view'), aiLimiter, byId, postClassify);
router.post(
  '/threads/:id/draft',
  authorize(FEATURE, 'create'),
  aiLimiter,
  validate({ params: idParams, body: draftBody }),
  postDraft,
);

export default router;
