import { isValidWhatsAppVerifyToken } from '../integrations/meta/whatsapp.js';
import { forbidden } from '../lib/errors.js';
import { sendList, sendOk } from '../lib/respond.js';
import {
  assignConversation,
  getConversation,
  getWhatsAppSetup,
  listConversations,
  sendText,
} from '../services/whatsapp.service.js';

// WhatsApp. Each function: read the validated request, call one service function, respond.

// GET /api/webhooks/meta/whatsapp: Meta checks the address once, when the webhook is set up.
// The right verify token is answered with the challenge text Meta sent.
export function getWhatsAppVerification(req, res, next) {
  const query = req.validated.query;
  if (query['hub.mode'] !== 'subscribe' || !isValidWhatsAppVerifyToken(query['hub.verify_token'])) {
    return next(forbidden('The verify token is not right.'));
  }
  return res
    .status(200)
    .type('text/plain')
    .send(query['hub.challenge'] ?? '');
}

// GET /api/whatsapp/setup: is WhatsApp set up, and what is missing.
export function getSetup(req, res) {
  sendOk(res, getWhatsAppSetup());
}

// GET /api/whatsapp/conversations
export async function getConversations(req, res) {
  const { items, pagination } = await listConversations(req.user, req.validated.query);
  sendList(res, items, pagination);
}

// GET /api/whatsapp/conversations/:id (opening it marks it as read)
export async function getConversationById(req, res) {
  sendOk(res, await getConversation(req.user, req.validated.params.id));
}

// POST /api/whatsapp/conversations/:id/messages: answer with a text.
export async function postMessage(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await sendText(req.user, params.id, body, { requestId: req.id }));
}

// PATCH /api/whatsapp/conversations/:id/assign
export async function patchAssign(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await assignConversation(req.user, params.id, body, { requestId: req.id }));
}
