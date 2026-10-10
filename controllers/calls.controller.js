import { emptyXml } from '../integrations/plivo/client.js';
import { sendCreated, sendList, sendOk } from '../lib/respond.js';
import {
  answerConnect,
  answerConsent,
  answerInbound,
  getCallSettings,
  getRecordingLink,
  listCalls,
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

// POST /api/webhooks/plivo/dial-result and /recording: noted; nothing more for Plivo to do.
export function respondNothing(req, res) {
  sendXml(res, emptyXml());
}
