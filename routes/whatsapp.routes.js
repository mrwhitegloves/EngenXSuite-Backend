import { Router } from 'express';
import { createWebhookHandler } from '../controllers/webhooks/receive.js';
import {
  getConversationById,
  getConversations,
  getSetup,
  getWhatsAppVerification,
  patchAssign,
  postMessage,
} from '../controllers/whatsapp.controller.js';
import { isValidWhatsAppSignature } from '../integrations/meta/whatsapp.js';
import { authorize } from '../middleware/authorize.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import { idParams } from '../validation/common.js';
import {
  assignBody,
  listConversationsQuery,
  sendTextBody,
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

router.use(requireAuth);
router.get('/setup', authorize(FEATURE, 'view'), getSetup);
router.get(
  '/conversations',
  authorize(FEATURE, 'view'),
  validate({ query: listConversationsQuery }),
  getConversations,
);
router.get(
  '/conversations/:id',
  authorize(FEATURE, 'view'),
  validate({ params: idParams }),
  getConversationById,
);
router.post(
  '/conversations/:id/messages',
  authorize(FEATURE, 'create'),
  validate({ params: idParams, body: sendTextBody }),
  postMessage,
);
router.patch(
  '/conversations/:id/assign',
  authorize(FEATURE, 'edit'),
  validate({ params: idParams, body: assignBody }),
  patchAssign,
);

export default router;
