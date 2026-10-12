import { sendList, sendOk } from '../lib/respond.js';
import {
  classifyNow,
  draftAnswer,
  getMailboxStatus,
  getThread,
  listAccountFiles,
  listThreads,
  requestSync,
  sendEmail,
  uploadAttachment,
  writeWithAi,
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

// POST /api/emails/attachments: keep a file I picked, to send with my next mail.
export async function postAttachment(req, res) {
  sendOk(res, await uploadAttachment(req.user, req.file));
}

// GET /api/emails/files?accountId=…: the files of one company's mail.
export async function getFiles(req, res) {
  sendOk(res, await listAccountFiles(req.user, req.validated.query.accountId));
}

// POST /api/emails/write: the AI writes a mail, or changes the one on the screen. Sends nothing.
export async function postWrite(req, res) {
  sendOk(res, await writeWithAi(req.user, req.validated.body));
}
