import { sendOk } from '../lib/respond.js';
import { chat, readChatFile } from '../services/aiChat.service.js';
import { getTranscript, makeTranscript } from '../services/callTranscripts.service.js';

// The AI assistant and the text of a call.
// Each function: read the validated request, call one service function, respond.

// POST /api/ai/chat: one turn of the assistant. Nothing of the conversation is saved.
export async function postChat(req, res) {
  sendOk(res, await chat(req.user, req.validated.body));
}

// POST /api/ai/chat/files: turn a file into text for the chat. The file is not stored.
export async function postChatFile(req, res) {
  sendOk(res, await readChatFile(req.user, req.file));
}

// GET /api/calls/:id/transcript: the saved text of a call.
export async function getCallTranscript(req, res) {
  sendOk(res, await getTranscript(req.user, req.validated.params.id));
}

// POST /api/calls/:id/transcript: make the text from the recording (again).
export async function postCallTranscript(req, res) {
  sendOk(res, await makeTranscript(req.user, req.validated.params.id, { requestId: req.id }));
}
