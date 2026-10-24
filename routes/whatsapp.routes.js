import { Router } from 'express';
import { createWebhookHandler } from '../controllers/webhooks/receive.js';
import {
  getConversationById,
  getConversations,
  getSetup,
  getStatus,
  getTemplates,
  getWhatsAppVerification,
  patchAssign,
  patchContact,
  postAssist,
  postContactConversation,
  postDocument,
  postFile,
  postMessage,
  postRead,
  postTemplate,
  postTemplateHeader,
} from '../controllers/whatsapp.controller.js';
import { isValidWhatsAppSignature } from '../integrations/meta/whatsapp.js';
import { authorize } from '../middleware/authorize.js';
import { createAiLimiter } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { singleFileUpload } from '../middleware/upload.js';
import { validate } from '../middleware/validate.js';
import { MAX_WHATSAPP_UPLOAD_BYTES } from '../services/whatsappMedia.service.js';
import { idParams } from '../validation/common.js';
import {
  assignBody,
  assistBody,
  linkContactBody,
  listConversationsQuery,
  sendDocumentBody,
  sendFileBody,
  sendTemplateBody,
  sendTextBody,
  templatesQuery,
  threadQuery,
  whatsappVerifyQuery,
} from '../validation/whatsapp.js';

// ── Meta's webhook (/api/webhooks/meta/whatsapp). No sign-in: Meta's signature is the check.
export const whatsappWebhooksRouter = Router();
whatsappWebhooksRouter.get(
  '/whatsapp',
  validate({ query: whatsappVerifyQuery }),
  getWhatsAppVerification,
);
whatsappWebhooksRouter.post(
  '/whatsapp',
  createWebhookHandler({
    provider: 'whatsapp',
    verify: (req) => isValidWhatsAppSignature(req.rawBody, req.get('x-hub-signature-256')),
    // Meta sends no event id: the receiver uses a hash of the body, so a repeat is recognised.
  }),
);

// ── The screens (/api/whatsapp). authorize() answers "may this person use WhatsApp at all";
// which conversation exactly is decided in the service.
const router = Router();
const FEATURE = 'whatsapp';
const aiLimiter = createAiLimiter();
const upload = singleFileUpload({ maxBytes: MAX_WHATSAPP_UPLOAD_BYTES });
const byId = validate({ params: idParams });

router.use(requireAuth);
router.get('/setup', authorize(FEATURE, 'view'), getSetup);
router.get('/status', authorize(FEATURE, 'view'), getStatus);
router.get(
  '/templates',
  authorize(FEATURE, 'view'),
  validate({ query: templatesQuery }),
  getTemplates,
);
router.get(
  '/conversations',
  authorize(FEATURE, 'view'),
  validate({ query: listConversationsQuery }),
  getConversations,
);
router.post(
  '/contacts/:id/conversation',
  authorize(FEATURE, 'view'),
  byId,
  postContactConversation,
);
router.get(
  '/conversations/:id',
  authorize(FEATURE, 'view'),
  validate({ params: idParams, query: threadQuery }),
  getConversationById,
);
router.post('/conversations/:id/read', authorize(FEATURE, 'view'), byId, postRead);
router.post(
  '/conversations/:id/messages',
  authorize(FEATURE, 'create'),
  validate({ params: idParams, body: sendTextBody }),
  postMessage,
);
router.post(
  '/conversations/:id/files',
  authorize(FEATURE, 'create'),
  upload,
  validate({ params: idParams, body: sendFileBody }),
  postFile,
);
router.post(
  '/conversations/:id/documents',
  authorize(FEATURE, 'create'),
  validate({ params: idParams, body: sendDocumentBody }),
  postDocument,
);
router.post(
  '/conversations/:id/template-header',
  authorize(FEATURE, 'create'),
  upload,
  byId,
  postTemplateHeader,
);
router.post(
  '/conversations/:id/templates',
  authorize(FEATURE, 'create'),
  validate({ params: idParams, body: sendTemplateBody }),
  postTemplate,
);
router.patch(
  '/conversations/:id/assign',
  authorize(FEATURE, 'edit'),
  validate({ params: idParams, body: assignBody }),
  patchAssign,
);
router.patch(
  '/conversations/:id/contact',
  authorize(FEATURE, 'edit'),
  validate({ params: idParams, body: linkContactBody }),
  patchContact,
);
router.post(
  '/conversations/:id/assist',
  authorize(FEATURE, 'view'),
  aiLimiter,
  validate({ params: idParams, body: assistBody }),
  postAssist,
);

export default router;
