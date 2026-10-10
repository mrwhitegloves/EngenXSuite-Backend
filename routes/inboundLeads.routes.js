import { Router } from 'express';
import {
  getAssignment,
  getInboundLeads,
  getLeadForms,
  getMetaVerification,
  patchAssignment,
  patchLeadForm,
  postRetryInboundLead,
} from '../controllers/inboundLeads.controller.js';
import { createWebhookHandler } from '../controllers/webhooks/receive.js';
import { isValidMetaSignature } from '../integrations/meta/leadAds.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { idParams } from '../validation/common.js';
import {
  listInboundLeadsQuery,
  metaVerifyQuery,
  updateLeadAssignmentBody,
  updateLeadFormBody,
} from '../validation/inboundLeads.js';

// ── Provider webhooks (/api/webhooks/…). No sign-in: the provider's signature is the check.
export const webhooksRouter = Router();
webhooksRouter.get('/meta/leads', validate({ query: metaVerifyQuery }), getMetaVerification);
webhooksRouter.post(
  '/meta/leads',
  createWebhookHandler({
    provider: 'meta_leads',
    verify: (req) => isValidMetaSignature(req.rawBody, req.get('x-hub-signature-256')),
    // Meta sends no event id: the receiver uses a hash of the body, so a repeat is recognised.
  }),
);

// ── Settings screens: lead forms, inbound leads, the assignment rule. For people who manage
// the settings (the CEO by default).
const settings = (action) => [requireAuth, authorize('settings', action)];

export const leadFormsRouter = Router();
leadFormsRouter.get('/', ...settings('view'), getLeadForms);
leadFormsRouter.patch(
  '/:id',
  ...settings('edit'),
  validate({ params: idParams, body: updateLeadFormBody }),
  patchLeadForm,
);

export const inboundLeadsRouter = Router();
inboundLeadsRouter.get(
  '/',
  ...settings('view'),
  validate({ query: listInboundLeadsQuery }),
  getInboundLeads,
);
inboundLeadsRouter.post(
  '/:id/retry',
  ...settings('edit'),
  validate({ params: idParams }),
  postRetryInboundLead,
);

export const leadAssignmentRouter = Router();
leadAssignmentRouter.get('/', ...settings('view'), getAssignment);
leadAssignmentRouter.patch(
  '/',
  ...settings('edit'),
  validate({ body: updateLeadAssignmentBody }),
  patchAssignment,
);
