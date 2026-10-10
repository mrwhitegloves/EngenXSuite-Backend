import { isValidVerifyToken } from '../integrations/meta/leadAds.js';
import { forbidden } from '../lib/errors.js';
import { sendList, sendOk } from '../lib/respond.js';
import {
  listInboundLeads,
  listLeadForms,
  retryInboundLead,
  updateLeadForm,
} from '../services/inboundLeads.service.js';
import { getLeadAssignment, updateLeadAssignment } from '../services/leadAssignment.service.js';

// Lead forms, inbound leads and the lead assignment rule.
// Each function: read the validated request, call one service function, respond.

const context = (req) => ({ requestId: req.id });

// GET /api/webhooks/meta/leads: Meta asks once "is this address yours?" when the webhook is
// set up. The right verify token is answered with the challenge text Meta sent.
export function getMetaVerification(req, res, next) {
  const query = req.validated.query;
  if (query['hub.mode'] !== 'subscribe' || !isValidVerifyToken(query['hub.verify_token'])) {
    return next(forbidden('The verify token is not right.'));
  }
  return res
    .status(200)
    .type('text/plain')
    .send(query['hub.challenge'] ?? '');
}

// GET /api/settings/lead-assignment
export async function getAssignment(req, res) {
  sendOk(res, await getLeadAssignment());
}

// PATCH /api/settings/lead-assignment
export async function patchAssignment(req, res) {
  sendOk(res, await updateLeadAssignment(req.user, req.validated.body, context(req)));
}

// GET /api/lead-forms: the forms with their mapping, and whether Meta is set up.
export async function getLeadForms(req, res) {
  sendOk(res, await listLeadForms());
}

// PATCH /api/lead-forms/:id
export async function patchLeadForm(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await updateLeadForm(req.user, params.id, body, context(req)));
}

// GET /api/inbound-leads
export async function getInboundLeads(req, res) {
  const { items, pagination } = await listInboundLeads(req.validated.query);
  sendList(res, items, pagination);
}

// POST /api/inbound-leads/:id/retry
export async function postRetryInboundLead(req, res) {
  sendOk(res, await retryInboundLead(req.user, req.validated.params.id, context(req)));
}
