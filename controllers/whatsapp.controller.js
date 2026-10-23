import { isValidWhatsAppVerifyToken } from '../integrations/meta/whatsapp.js';
import { forbidden } from '../lib/errors.js';
import { sendCreated, sendList, sendOk } from '../lib/respond.js';
import { assistOnConversation } from '../services/whatsappAssist.service.js';
import {
  assignConversation,
  getConversation,
  getWhatsAppSetup,
  getWhatsAppStatus,
  linkConversation,
  listConversations,
  listTemplates,
  markConversationRead,
  openConversationForContact,
  sendFile,
  sendLibraryDocument,
  sendTemplate,
  sendText,
  uploadTemplateHeader,
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

// GET /api/whatsapp/status: the setup and the business number (Settings → WhatsApp).
export async function getStatus(req, res) {
  sendOk(res, await getWhatsAppStatus());
}

// GET /api/whatsapp/templates
export async function getTemplates(req, res) {
  sendOk(res, await listTemplates(req.validated.query));
}

// GET /api/whatsapp/conversations: a page of conversations and the count of each tab.
export async function getConversations(req, res) {
  const { items, pagination, counts } = await listConversations(req.user, req.validated.query);
  // The list shape ({ data, meta }) with the tab counts beside the page numbers.
  sendList(res, items, { ...pagination, counts });
}

// GET /api/whatsapp/conversations/:id (the first page marks it as read)
export async function getConversationById(req, res) {
  const { params, query } = req.validated;
  sendOk(res, await getConversation(req.user, params.id, query));
}

// POST /api/whatsapp/conversations/:id/read
export async function postRead(req, res) {
  sendOk(res, await markConversationRead(req.user, req.validated.params.id));
}

// POST /api/whatsapp/contacts/:id/conversation: the chat with this person, made when needed.
export async function postContactConversation(req, res) {
  const result = await openConversationForContact(req.user, req.validated.params.id);
  return result.created ? sendCreated(res, result) : sendOk(res, result);
}

// POST /api/whatsapp/conversations/:id/messages: answer with a text.
export async function postMessage(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await sendText(req.user, params.id, body, { requestId: req.id }));
}

// POST /api/whatsapp/conversations/:id/files: send a file (multipart: file, caption, replyToId).
export async function postFile(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await sendFile(req.user, params.id, req.file, body, { requestId: req.id }));
}

// POST /api/whatsapp/conversations/:id/documents: send a document of the library.
export async function postDocument(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await sendLibraryDocument(req.user, params.id, body, { requestId: req.id }));
}

// POST /api/whatsapp/conversations/:id/template-header: keep the header file of a template.
export async function postTemplateHeader(req, res) {
  sendCreated(res, await uploadTemplateHeader(req.user, req.validated.params.id, req.file));
}

// POST /api/whatsapp/conversations/:id/templates: send an approved template.
export async function postTemplate(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await sendTemplate(req.user, params.id, body, { requestId: req.id }));
}

// PATCH /api/whatsapp/conversations/:id/assign
export async function patchAssign(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await assignConversation(req.user, params.id, body, { requestId: req.id }));
}

// PATCH /api/whatsapp/conversations/:id/contact: say which person of the CRM it is.
export async function patchContact(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await linkConversation(req.user, params.id, body, { requestId: req.id }));
}

// POST /api/whatsapp/conversations/:id/assist: "What should I say?" or a summary (AI).
export async function postAssist(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await assistOnConversation(req.user, params.id, body));
}
