import { sendCreated, sendList, sendOk } from '../lib/respond.js';
import { listAccounts } from '../services/accounts.service.js';
import {
  addSegment,
  findMeetingForCode,
  getRecorderTranscript,
  startRecording,
  stopRecording,
} from '../services/meetingTranscripts.service.js';
import { listLeads } from '../services/opportunities.service.js';
import {
  createPairingCode,
  disconnectRecorder,
  listMyRecorders,
  pairRecorder,
} from '../services/recorderDevices.service.js';

// The meeting recorder (Chrome extension). Each function: read the validated request, call
// one service function, respond. Routes in routes/recorder.routes.js.

// ── In the CRM (signed in with the session) ──

// GET /api/recorder/devices: my connected recorders.
export async function getMyRecorders(req, res) {
  sendOk(res, await listMyRecorders(req.user));
}

// POST /api/recorder/pairing-codes: a code to type into the extension.
export async function postPairingCode(req, res) {
  sendCreated(res, await createPairingCode(req.user, { requestId: req.id }));
}

// DELETE /api/recorder/devices/:deviceId: disconnect one of my recorders.
export async function removeRecorder(req, res) {
  const { deviceId } = req.validated.params;
  sendOk(res, await disconnectRecorder(req.user, deviceId, { requestId: req.id }));
}

// ── From the extension ──

// POST /api/recorder/pair: trade a pairing code for the recorder's token.
export async function postPair(req, res) {
  sendOk(res, await pairRecorder(req.validated.body, { requestId: req.id }));
}

// GET /api/recorder/me: who this recorder records for.
export async function getRecorderMe(req, res) {
  sendOk(res, {
    user: { id: String(req.user._id), name: req.user.name, email: req.user.email },
    device: req.recorder,
  });
}

// POST /api/recorder/disconnect: the extension disconnects itself.
export async function postDisconnect(req, res) {
  sendOk(res, await disconnectRecorder(req.user, req.recorder.id, { requestId: req.id }));
}

// GET /api/recorder/meetings/match?code=: the CRM meeting of this Meet call, and my meetings today.
export async function getMeetingMatch(req, res) {
  sendOk(res, await findMeetingForCode(req.user, req.validated.query));
}

// GET /api/recorder/accounts?search=: companies in my scope, to choose the meeting's company.
export async function getRecorderAccounts(req, res) {
  const { items, pagination } = await listAccounts(req.user, req.validated.query);
  sendList(
    res,
    items.map((account) => ({ id: account.id, name: account.name, code: account.accountCode })),
    pagination,
  );
}

// GET /api/recorder/leads?accountId=: the leads of that company I may see.
export async function getRecorderLeads(req, res) {
  const { items, pagination } = await listLeads(req.user, req.validated.query);
  sendList(
    res,
    items.map((lead) => ({ id: lead.id, name: lead.name, code: lead.leadCode })),
    pagination,
  );
}

// POST /api/recorder/recordings: start recording this Meet call.
export async function postRecording(req, res) {
  sendCreated(
    res,
    await startRecording(req.user, req.validated.body, {
      requestId: req.id,
      deviceId: req.recorder.id,
    }),
  );
}

// POST /api/recorder/recordings/:recordingId/segments?clientKey=&track=&startedAt=
// The body is one piece of speech (audio/wav).
export async function postSegment(req, res) {
  const { params, query } = req.validated;
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  sendOk(res, await addSegment(req.user, params.recordingId, query, body));
}

// POST /api/recorder/recordings/:recordingId/stop
export async function postStop(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await stopRecording(req.user, params.recordingId, body, { requestId: req.id }));
}

// GET /api/recorder/recordings/:recordingId/transcript: the newest lines, for the side panel.
export async function getLiveTranscript(req, res) {
  sendOk(res, await getRecorderTranscript(req.user, req.validated.params.recordingId));
}
