import { emptyXml } from '../integrations/plivo/client.js';
import { sendCreated, sendList, sendOk } from '../lib/respond.js';
import {
  answerConnect,
  answerConsent,
  answerDialResult,
  answerInbound,
  getBrowserPhone,
  getCallSettings,
  getCallDetail,
  getCallFormOptions,
  getRecordingLink,
  listCalls,
  removeRingtone,
  saveRingtone,
  startBrowserCall,
  startCall,
  updateCall,
  updateCallSettings,
} from '../services/calls.service.js';

// Phone calls. Each function: read the validated request, call one service function, respond.

const context = (req) => ({ requestId: req.id });
const sendXml = (res, xml) => res.status(200).type('text/xml').send(xml);

// POST /api/calls: ring my phone, then join the contact.
export async function postCall(req, res) {
  sendCreated(res, await startCall(req.user, req.validated.body, context(req)));
}

// GET /api/calls?opportunityId=… | accountId=… | contactId=…
export async function getCalls(req, res) {
  const { items, pagination } = await listCalls(req.user, req.validated.query);
  sendList(res, items, pagination);
}

// GET /api/calls/form-options: whose calls I may filter by.
export async function getFormOptions(req, res) {
  sendOk(res, await getCallFormOptions(req.user));
}

// GET /api/calls/:id: one call in full (times, both sides, what happened).
export async function getCallById(req, res) {
  sendOk(res, await getCallDetail(req.user, req.validated.params.id));
}

// PATCH /api/calls/:id: what came of the call.
export async function patchCall(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await updateCall(req.user, params.id, body, context(req)));
}

// GET /api/calls/:id/recording: a link to listen to it.
export async function getRecording(req, res) {
  sendOk(res, await getRecordingLink(req.user, req.validated.params.id, context(req)));
}

// GET /api/settings/calls
export async function getSettings(req, res) {
  sendOk(res, await getCallSettings());
}

// PATCH /api/settings/calls
export async function patchSettings(req, res) {
  sendOk(res, await updateCallSettings(req.user, req.validated.body, context(req)));
}

// POST /api/settings/calls/ringtone: our own ringtone for calls into the browser.
export async function postRingtone(req, res) {
  sendOk(res, await saveRingtone(req.user, req.file, context(req)));
}

// DELETE /api/settings/calls/ringtone: back to Plivo's ringtone.
export async function deleteRingtone(req, res) {
  sendOk(res, await removeRingtone(req.user, context(req)));
}

// GET /api/calls/browser-phone: may my browser take part in calls, and its sign-in.
export async function getBrowserPhoneSignIn(req, res) {
  sendOk(res, await getBrowserPhone(req.user));
}

// POST /api/calls/browser: call a contact from my browser (the call is written; the browser
// then dials through Plivo).
export async function postBrowserCall(req, res) {
  sendCreated(res, await startBrowserCall(req.user, req.validated.body, context(req)));
}

// What Plivo is told at once, as XML. (The webhook receiver has verified and stored the event.)

// POST /api/webhooks/plivo/connect?call=<id>: the agent picked up; dial the customer.
export async function respondConnect(req, res) {
  sendXml(res, await answerConnect(req.query.call));
}

// POST /api/webhooks/plivo/inbound: a customer called our number; ring the right person.
export async function respondInbound(req, res) {
  sendXml(res, await answerInbound(req.body ?? {}));
}

// POST /api/webhooks/plivo/consent: the "this call may be recorded" announcement.
export async function respondConsent(req, res) {
  sendXml(res, await answerConsent());
}

// POST /api/webhooks/plivo/dial-result?call=<id>&step=1|2: the rung phone ended. For an inbound
// call nobody picked up, the answer may be "now ring the next person".
export async function respondDialResult(req, res) {
  sendXml(res, await answerDialResult(req.query.call, req.query.step, req.body ?? {}));
}

// POST /api/webhooks/plivo/recording: noted; nothing more for Plivo to do.
export function respondNothing(req, res) {
  sendXml(res, emptyXml());
}
