import { sendCreated, sendOk } from '../lib/respond.js';
import { requestCalendarSync } from '../services/calendarSync.service.js';
import {
  addExternalAnalysis,
  addMeetingFile,
  decideProposedTask,
  deleteExternalAnalysis,
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
import {
  downloadTranscript,
  editTranscriptSegment,
  getMeetingTranscript,
  getSegmentAudioLink,
} from '../services/meetingTranscripts.service.js';

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

// POST /api/meetings/sync: read the company calendar now.
export async function postSync(req, res) {
  sendOk(res, await requestCalendarSync());
}

// GET /api/meetings/:id/record: the AI's summary of the meeting (when made) and its files.
export async function getRecord(req, res) {
  sendOk(res, await getMeetingRecord(req.user, req.validated.params.id));
}

// POST /api/meetings/:id/summary: let the AI summarize the meeting from its transcript or notes.
export async function postSummary(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await summarizeMeetingNow(req.user, params.id, body));
}

// POST /api/meetings/:id/analyses: paste an analysis made outside the CRM.
export async function postAnalysis(req, res) {
  const { params, body } = req.validated;
  sendCreated(res, await addExternalAnalysis(req.user, params.id, body, { requestId: req.id }));
}

// DELETE /api/meetings/:id/analyses/:analysisId
export async function removeAnalysis(req, res) {
  const { id, analysisId } = req.validated.params;
  sendOk(res, await deleteExternalAnalysis(req.user, id, analysisId, { requestId: req.id }));
}

// GET /api/meetings/:id/transcript: the transcript of the meeting recorder.
export async function getTranscript(req, res) {
  sendOk(res, await getMeetingTranscript(req.user, req.validated.params.id));
}

// GET /api/meetings/:id/transcript/download: the transcript as a text file.
export async function getTranscriptDownload(req, res) {
  const file = await downloadTranscript(req.user, req.validated.params.id, { requestId: req.id });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.status(200).send(file.text);
}

// PATCH /api/meetings/:id/transcript/segments/:segmentId: correct the words of one part.
export async function patchSegment(req, res) {
  const { params, body } = req.validated;
  sendOk(
    res,
    await editTranscriptSegment(req.user, params.id, params.segmentId, body, {
      requestId: req.id,
    }),
  );
}

// GET /api/meetings/:id/transcript/segments/:segmentId/audio: a link to listen to one part.
export async function getSegmentAudio(req, res) {
  const { id, segmentId } = req.validated.params;
  sendOk(res, await getSegmentAudioLink(req.user, id, segmentId));
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
