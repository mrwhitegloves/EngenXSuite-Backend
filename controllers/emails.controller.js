import { sendList, sendOk } from '../lib/respond.js';
import {
  classifyNow,
  draftAnswer,
  getMailboxStatus,
  getThread,
  listThreads,
  requestSync,
  sendEmail,
} from '../services/emails.service.js';

// Customer mail. Each function: read the validated request, call one service function, respond.

// GET /api/emails/threads
export async function getThreads(req, res) {
  const { items, pagination } = await listThreads(req.user, req.validated.query);
  sendList(res, items, pagination);
}

// GET /api/emails/threads/:id
export async function getThreadById(req, res) {
  sendOk(res, await getThread(req.user, req.validated.params.id));
}

// GET /api/emails/mailbox: is my mailbox connected, when was it last read.
export async function getMailbox(req, res) {
  sendOk(res, await getMailboxStatus(req.user));
}

// POST /api/emails/sync: read my mailbox now.
export async function postSync(req, res) {
  sendOk(res, await requestSync(req.user));
}

// POST /api/emails/send: an answer in a conversation, or a new mail, from my own mailbox.
export async function postSend(req, res) {
  sendOk(res, await sendEmail(req.user, req.validated.body, { requestId: req.id }));
}

// POST /api/emails/threads/:id/classify: ask the AI to read the conversation again.
export async function postClassify(req, res) {
  sendOk(res, await classifyNow(req.user, req.validated.params.id));
}

// POST /api/emails/threads/:id/draft: a draft answer by the AI. Nothing is sent.
export async function postDraft(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await draftAnswer(req.user, params.id, body));
}
