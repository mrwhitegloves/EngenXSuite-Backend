import { sendCreated, sendOk } from '../lib/respond.js';
import { requestCalendarSync } from '../services/calendarSync.service.js';
import {
  addMeetingFile,
  decideProposedTask,
  getMeetingRecord,
  summarizeMeetingNow,
  transcribeMeetingFile,
} from '../services/meetingSummaries.service.js';
import {
  closeMeeting,
  createMeeting,
  deleteMeeting,
  getMeeting,
  getMeetingFormOptions,
  listMeetings,
  updateMeeting,
} from '../services/meetings.service.js';

// Meetings. Each function: read the validated request, call one service function, respond.

// GET /api/meetings: a span of days for the calendar, or the meetings of one lead or company.
export async function getMeetings(req, res) {
  sendOk(res, await listMeetings(req.user, req.validated.query));
}

// GET /api/meetings/form-options
export async function getFormOptions(req, res) {
  sendOk(res, await getMeetingFormOptions(req.user));
}

// GET /api/meetings/:id
export async function getMeetingById(req, res) {
  sendOk(res, await getMeeting(req.user, req.validated.params.id));
}

// POST /api/meetings: plan a meeting; I am its organizer.
export async function postMeeting(req, res) {
  sendCreated(res, await createMeeting(req.user, req.validated.body, { requestId: req.id }));
}

// PATCH /api/meetings/:id: change or move a planned meeting, or write its notes.
export async function patchMeeting(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await updateMeeting(req.user, params.id, body, { requestId: req.id }));
}

// POST /api/meetings/:id/close: it was held, the customer did not come, or it is cancelled.
export async function postClose(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await closeMeeting(req.user, params.id, body, { requestId: req.id }));
}

// POST /api/meetings/sync: read my Google Calendar now.
export async function postSync(req, res) {
  sendOk(res, await requestCalendarSync(req.user));
}

// GET /api/meetings/:id/record: the AI's summary of the meeting (when made) and its files.
export async function getRecord(req, res) {
  sendOk(res, await getMeetingRecord(req.user, req.validated.params.id));
}

// POST /api/meetings/:id/summary: let the AI summarize the meeting from its notes.
export async function postSummary(req, res) {
  sendOk(res, await summarizeMeetingNow(req.user, req.validated.params.id));
}

// POST /api/meetings/:id/summary/tasks: accept or reject a task the AI proposed.
export async function postDecideTask(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await decideProposedTask(req.user, params.id, body, { requestId: req.id }));
}

// POST /api/meetings/:id/files: a picture, a document or a voice note of the meeting.
export async function postFile(req, res) {
  sendCreated(res, await addMeetingFile(req.user, req.validated.params.id, req.file));
}

// POST /api/meetings/:id/files/transcribe: turn a voice note into text, into the notes.
export async function postTranscribe(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await transcribeMeetingFile(req.user, params.id, body));
}

// DELETE /api/meetings/:id: delete a meeting for good.
export async function removeMeeting(req, res) {
  sendOk(res, await deleteMeeting(req.user, req.validated.params.id, {}, { requestId: req.id }));
}
