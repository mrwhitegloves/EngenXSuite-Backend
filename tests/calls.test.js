import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';

// The Plivo settings exist only for this test file; they are set before the app reads them.
Object.assign(process.env, {
  PLIVO_AUTH_ID: 'test-auth-id',
  PLIVO_AUTH_TOKEN: 'test-auth-token',
  PLIVO_NUMBER: '918035000000',
  PLIVO_APP_ID: 'test-app-id',
  API_PUBLIC_URL: 'https://api.example.test',
});

// Plivo itself is replaced: starting a call is collected here, a webhook counts as signed when
// it carries the test header, and a recording "download" gives a few bytes. The XML answers
// are the real ones.
const placed = [];
let plivoFails = false;
// Plivo's own record of a finished leg (what its console shows), by the leg's UUID.
const plivoRecords = new Map();
// Browsers (calls inside the CRM): the endpoints Plivo made, and the sign-ins it gave.
const endpoints = [];
const tokens = [];
vi.mock('../integrations/plivo/client.js', async (importActual) => ({
  ...(await importActual()),
  startCall: async (options) => {
    if (plivoFails) {
      const error = new Error('Plivo could not start the call: insufficient credit');
      Object.assign(error, { isAppError: true, status: 502, code: 'PLIVO_ERROR' });
      throw error;
    }
    placed.push(options);
    return { requestUuid: `request-${placed.length}` };
  },
  getCallRecord: async (uuid) => plivoRecords.get(uuid) ?? null,
  createEndpoint: async ({ name, alias }) => {
    endpoints.push({ name, alias });
    return { id: `ep-${endpoints.length}`, username: `${name}1610${endpoints.length}` };
  },
  createAccessToken: async ({ username, validSec }) => {
    tokens.push({ username, validSec });
    return { token: `jwt-for-${username}`, expiresAt: new Date(Date.now() + validSec * 1000) };
  },
  isValidPlivoSignature: (req) => req.get('x-test-signature') === 'ok',
  downloadRecording: async () => ({ body: Buffer.from('mp3-bytes'), contentType: 'audio/mpeg' }),
}));

// File storage is a Map, so the tests never reach AWS.
const BUCKET_URL = 'https://test-bucket.s3.ap-south-1.amazonaws.com/';
const stored = new Map();
vi.mock('../infra/storage.js', () => ({
  isStorageConfigured: () => true,
  objectUrl: (key) => `${BUCKET_URL}${key}`,
  keyFromUrl: (url) => (url?.startsWith(BUCKET_URL) ? url.slice(BUCKET_URL.length) : null),
  uploadObject: async ({ key, body }) => {
    stored.set(key, Buffer.from(body));
    return `${BUCKET_URL}${key}`;
  },
  readObject: async (key) => stored.get(key) ?? null,
  deleteObject: async (key) => {
    stored.delete(key);
  },
  toReadableUrl: async (url) => (url ? `${url}?X-Amz-Signature=test` : null),
}));

const { createApp } = await import('../app.js');
const { createSessionMiddleware } = await import('../middleware/session.js');
const { Activity } = await import('../models/activity.model.js');
const { AuditLog } = await import('../models/auditLog.model.js');
const { Call } = await import('../models/call.model.js');
const { Contact } = await import('../models/contact.model.js');
const { Notification } = await import('../models/notification.model.js');
const { Role } = await import('../models/role.model.js');
const { Task } = await import('../models/task.model.js');
const { User } = await import('../models/user.model.js');
const { WebhookEvent } = await import('../models/webhookEvent.model.js');
const { runSeed, seedStartingLists, seedStatusLists } = await import('../seeds/seed.js');
const { settleCall, settleWaitingCalls } = await import('../services/calls.service.js');
const { processWebhookEvent } = await import('../services/webhooks.service.js');
const { clearTestDb, startTestDbWithTransactions, stopTestDb } =
  await import('./helpers/testDb.js');

const PASSWORD = 'correct-horse-battery';
let app;
let agent;
let asCeo;
let asAgent;
let asOther;
let contactId;
let leadId;

async function signedInAs(user) {
  const client = request.agent(app);
  const response = await client
    .post('/api/auth/login')
    .send({ email: user.email, password: PASSWORD });
  expect(response.status).toBe(200);
  return client;
}

/** One webhook from "Plivo" (form fields), then the background job for it. */
async function hook(kind, fields = {}, { call, signed = true } = {}) {
  const response = await request(app)
    .post(`/api/webhooks/plivo/${kind}${call ? `?call=${call}` : ''}`)
    .set('X-Test-Signature', signed ? 'ok' : 'no')
    .type('form')
    .send(fields);
  if (response.status === 200) {
    const event = await WebhookEvent.findOne({ provider: 'plivo' }).sort({ _id: -1 }).lean();
    await processWebhookEvent(event._id);
  }
  return response;
}

const startCall = (client, body = {}) =>
  client.post('/api/calls').send({ contactId, opportunityId: leadId, ...body });

beforeAll(async () => {
  // Creating a lead uses a transaction.
  await startTestDbWithTransactions();
  app = createApp({ sessionMiddleware: createSessionMiddleware() });
});
afterAll(stopTestDb);

beforeEach(async () => {
  await clearTestDb();
  placed.length = 0;
  endpoints.length = 0;
  tokens.length = 0;
  stored.clear();
  plivoFails = false;
  await runSeed({ productName: 'P', companyName: 'C', workspaceDomain: 'engenx.in' });
  await seedStatusLists();
  await seedStartingLists();
  const roles = Object.fromEntries((await Role.find()).map((role) => [role.name, role]));
  const makeUser = (email, name, roleName, phone) =>
    User.create({
      email,
      name,
      roleId: roles[roleName]._id,
      status: 'active',
      password: PASSWORD,
      ...(phone ? { phone } : {}),
    });
  const ceo = await makeUser('ceo@engenx.in', 'Kunal CEO', 'CEO', '+919000000001');
  agent = await makeUser('agent@engenx.in', 'Asha Agent', 'Sales Agent', '90000 00002');
  const other = await makeUser('other@engenx.in', 'Omar Agent', 'Sales Agent');
  [asCeo, asAgent, asOther] = await Promise.all([ceo, agent, other].map(signedInAs));

  // The agent's company, person and lead.
  const created = await asAgent.post('/api/accounts/quick-add').send({
    account: { name: 'Bharat Forge' },
    contacts: [{ name: 'Asha Verma', phone_number: '98765 43210' }],
    lead: { name: 'OEE for press line' },
  });
  contactId = created.body.data.contacts[0].id;
  leadId = created.body.data.lead.id;
  await AuditLog.deleteMany({});
});

describe('click-to-call', () => {
  it('rings the agent’s own phone, then joins the customer, and ends on the timeline', async () => {
    const response = await startCall(asAgent);
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      direction: 'outbound',
      status: 'initiated',
      number: '+919876543210',
      user: { name: 'Asha Agent' },
      contact: { name: 'Asha Verma' },
      opportunityId: leadId,
    });
    const callId = response.body.data.id;
    // Plivo was asked to ring the AGENT, and told where to ask next.
    expect(placed).toEqual([
      {
        to: '+919000000002',
        answerUrl: `https://api.example.test/api/webhooks/plivo/connect?call=${callId}`,
        hangupUrl: `https://api.example.test/api/webhooks/plivo/hangup?call=${callId}`,
      },
    ]);
    expect((await Call.findById(callId).lean()).plivoCallUuid).toBe('request-1');

    // The agent picks up: "dial the customer", who sees our number.
    const connect = await hook('connect', { CallUUID: 'request-1' }, { call: callId });
    expect(connect.headers['content-type']).toContain('text/xml');
    expect(connect.text).toContain('<Dial');
    expect(connect.text).toContain('callerId="918035000000"');
    expect(connect.text).toContain('<Number>919876543210</Number>');
    expect(connect.text).toContain(`dial-result?call=${callId}`);
    // Recording is off by default.
    expect(connect.text).not.toContain('<Record');
    expect((await Call.findById(callId).lean()).status).toBe('in_progress');

    await hook(
      'dial-result',
      {
        CallUUID: 'request-1',
        DialStatus: 'completed',
        DialBLegDuration: '65',
        DialBLegTotalCost: '0.5',
      },
      { call: callId },
    );
    await hook(
      'hangup',
      {
        CallUUID: 'request-1',
        CallStatus: 'completed',
        TotalCost: '0.25',
        HangupCause: 'NORMAL_CLEARING',
      },
      { call: callId },
    );
    const call = await Call.findById(callId).lean();
    expect(call).toMatchObject({ status: 'completed', durationSec: 65, cost: 0.75 });
    expect(call.endedAt).toBeInstanceOf(Date);

    const entry = await Activity.findOne({ type: 'CALL' }).lean();
    expect(entry).toMatchObject({
      subtype: 'call_ended',
      direction: 'outbound',
      title: 'Call to Asha Verma · 1:05',
      status: 'completed',
      metadata: { callId, durationSec: 65 },
    });
    expect(String(entry.opportunityId)).toBe(leadId);
    const timeline = (await asAgent.get(`/api/timeline?opportunityId=${leadId}&type=CALL`)).body
      .data;
    expect(timeline.map((item) => item.title)).toEqual(['Call to Asha Verma · 1:05']);

    // Plivo repeats the hang-up: still one timeline entry.
    await hook('hangup', { CallUUID: 'request-1', CallStatus: 'completed' }, { call: callId });
    expect(await Activity.countDocuments({ type: 'CALL' })).toBe(1);

    const calls = (await asAgent.get(`/api/calls?opportunityId=${leadId}`)).body.data;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ status: 'completed', durationSec: 65, hasRecording: false });
  });

  it('says how it ended when nobody talked', async () => {
    // The agent does not pick up their own phone.
    const first = (await startCall(asAgent)).body.data;
    await hook('hangup', { CallUUID: 'request-1', CallStatus: 'no-answer' }, { call: first.id });
    expect(await Call.findById(first.id).lean()).toMatchObject({
      status: 'no_answer',
      hangupCause: 'agent_did_not_pick_up',
      durationSec: 0,
    });
    // The agent picks up, the customer is busy.
    const second = (await startCall(asAgent)).body.data;
    await hook('connect', { CallUUID: 'request-2' }, { call: second.id });
    await hook('dial-result', { CallUUID: 'request-2', DialStatus: 'busy' }, { call: second.id });
    await hook('hangup', { CallUUID: 'request-2', CallStatus: 'completed' }, { call: second.id });
    expect((await Call.findById(second.id).lean()).status).toBe('busy');
    const titles = (await Activity.find({ type: 'CALL' }).sort({ _id: 1 }).lean()).map(
      (item) => item.title,
    );
    expect(titles).toEqual(['Call to Asha Verma · no answer', 'Call to Asha Verma · busy']);
  });

  it('is refused when it must not or cannot be made', async () => {
    // Someone else's contact does not exist for this person.
    expect((await asOther.post('/api/calls').send({ contactId })).status).toBe(404);
    expect((await request(app).post('/api/calls').send({ contactId })).status).toBe(401);
    expect((await asAgent.post('/api/calls').send({ contactId: 'nope' })).status).toBe(400);

    // The CEO has no lead access problem but the person asked not to be called.
    await asAgent.patch(`/api/contacts/${contactId}`).send({ consent: { doNotCall: true } });
    const refused = await startCall(asAgent);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe('Asha Verma asked not to be called.');
    await asAgent.patch(`/api/contacts/${contactId}`).send({ consent: { doNotCall: false } });

    // The caller needs a phone number of their own.
    await User.updateOne({ _id: agent._id }, { $unset: { phone: '' } });
    const noPhone = await startCall(asAgent);
    expect(noPhone.status).toBe(400);
    expect(noPhone.body.error.message).toContain('Your own phone number is missing');
    await User.updateOne({ _id: agent._id }, { $set: { phone: '9000000002' } });

    await asAgent.patch(`/api/contacts/${contactId}`).send({ phone_number: null });
    expect((await startCall(asAgent)).body.error.message).toBe('Asha Verma has no phone number.');
    await asAgent.patch(`/api/contacts/${contactId}`).send({ phone_number: '9876543210' });
    expect(placed).toEqual([]);
    expect(await Call.countDocuments()).toBe(0);

    // Plivo refuses: the reason is passed on, and the call is kept as failed.
    plivoFails = true;
    const failed = await startCall(asAgent);
    expect(failed.status).toBe(502);
    expect(failed.body.error.message).toContain('insufficient credit');
    expect(await Call.findOne().lean()).toMatchObject({
      status: 'failed',
      hangupCause: 'could_not_start',
    });
  });

  it('webhooks without Plivo’s signature are refused and change nothing', async () => {
    const call = (await startCall(asAgent)).body.data;
    for (const kind of ['connect', 'inbound', 'dial-result', 'hangup', 'recording', 'consent']) {
      const response = await hook(
        kind,
        { CallUUID: 'request-1' },
        { call: call.id, signed: false },
      );
      expect(response.status, kind).toBe(401);
    }
    expect((await Call.findById(call.id).lean()).status).toBe('initiated');
    expect(await Call.countDocuments()).toBe(1);
  });
});

describe('what Plivo really sends, and its own record of the call', () => {
  it('a call the customer picked up is "completed" without a length in the dial callback', async () => {
    plivoRecords.clear();
    const callId = (await startCall(asAgent)).body.data.id;
    await hook('connect', { CallUUID: 'request-1' }, { call: callId });
    // Plivo's dial callback: how it ended and the ids of the two sides. No length, no cost.
    await hook(
      'dial-result',
      {
        CallUUID: 'request-1',
        DialStatus: 'completed',
        DialRingStatus: 'true',
        DialHangupCause: 'NORMAL_CLEARING',
        DialALegUUID: 'request-1',
        DialBLegUUID: 'customer-leg-1',
      },
      { call: callId },
    );
    await hook(
      'hangup',
      {
        CallUUID: 'request-1',
        CallStatus: 'completed',
        Duration: '52',
        BillDuration: '60',
        TotalCost: '0.19',
      },
      { call: callId },
    );
    // At once: it went through; the length is the whole call for now, the charge one side.
    expect(await Call.findById(callId).lean()).toMatchObject({
      status: 'completed',
      durationSec: 52,
      cost: 0.19,
    });
    expect((await Activity.findOne({ type: 'CALL' }).lean()).title).toBe(
      'Call to Asha Verma · 0:52',
    );

    // Plivo's books are not ready yet.
    expect(await settleCall(callId)).toBe('not ready');
    // A little later they are: both sides, as the Plivo console shows them.
    plivoRecords.set('request-1', { durationSec: 60, cost: 0.19, hangupCause: 'Normal Hangup' });
    plivoRecords.set('customer-leg-1', {
      durationSec: 31,
      cost: 0.19,
      hangupCause: 'Normal Hangup',
    });
    await Call.updateOne(
      { _id: callId },
      { $set: { endedAt: new Date(Date.now() - 5 * 60 * 1000) } },
    );
    expect(await settleWaitingCalls()).toEqual({ looked: 1, settled: 1 });
    expect(await Call.findById(callId).lean()).toMatchObject({
      status: 'completed',
      durationSec: 31,
      cost: 0.38,
    });
    const entry = await Activity.findOne({ type: 'CALL' }).lean();
    expect(entry).toMatchObject({ title: 'Call to Asha Verma · 0:31', status: 'completed' });
    // Settled once: nothing more to do.
    expect(await settleCall(callId)).toBe('skipped');
    expect(await settleWaitingCalls()).toEqual({ looked: 0, settled: 0 });
  });

  it('a call nobody picked up stays "no answer", with what the ringing cost', async () => {
    plivoRecords.clear();
    const callId = (await startCall(asAgent)).body.data.id;
    await hook('connect', { CallUUID: 'request-1' }, { call: callId });
    await hook(
      'dial-result',
      { CallUUID: 'request-1', DialStatus: 'no-answer', DialBLegUUID: 'customer-leg-2' },
      { call: callId },
    );
    await hook(
      'hangup',
      { CallUUID: 'request-1', Duration: '30', TotalCost: '0.19' },
      { call: callId },
    );
    plivoRecords.set('request-1', { durationSec: 60, cost: 0.19, hangupCause: 'Normal Hangup' });
    plivoRecords.set('customer-leg-2', { durationSec: 0, cost: 0, hangupCause: 'No Answer' });
    expect(await settleCall(callId)).toBe('settled');
    expect(await Call.findById(callId).lean()).toMatchObject({
      status: 'no_answer',
      durationSec: 0,
      cost: 0.19,
    });
  });
});

describe('inbound calls', () => {
  const ring = (from, uuid = 'inbound-1') =>
    hook('inbound', { CallUUID: uuid, From: from, To: '918035000000' });

  it('a known caller rings the phone of the person who looks after them', async () => {
    const answer = await ring('919876543210');
    expect(answer.text).toContain('<Number>919000000002</Number>'); // the lead's owner
    const call = await Call.findOne({ plivoCallUuid: 'inbound-1' }).lean();
    expect(call).toMatchObject({
      direction: 'inbound',
      status: 'ringing',
      fromNumber: '+919876543210',
    });
    expect(String(call.userId)).toBe(String(agent._id));
    expect(String(call.contactId)).toBe(contactId);
    expect(String(call.opportunityId)).toBe(leadId);
    // Plivo asks again: the same call, not a second one.
    await ring('919876543210');
    expect(await Call.countDocuments()).toBe(1);

    await hook(
      'dial-result',
      { CallUUID: 'inbound-1', DialStatus: 'completed', DialBLegDuration: '120' },
      { call: call._id },
    );
    await hook('hangup', { CallUUID: 'inbound-1', CallStatus: 'completed' });
    expect(await Call.findById(call._id).lean()).toMatchObject({
      status: 'completed',
      durationSec: 120,
    });
    expect((await Activity.findOne({ type: 'CALL' }).lean()).title).toBe(
      'Call from Asha Verma · 2:00',
    );
    expect(await Notification.countDocuments()).toBe(0);
  });

  it('a missed call tells the person and gives them one call-back task', async () => {
    await ring('919876543210');
    const call = await Call.findOne().lean();
    await hook(
      'dial-result',
      { CallUUID: 'inbound-1', DialStatus: 'no-answer' },
      { call: call._id },
    );
    await hook('hangup', { CallUUID: 'inbound-1', CallStatus: 'completed' });
    // The hang-up is delivered again.
    await hook('hangup', { CallUUID: 'inbound-1', CallStatus: 'completed', HangupCause: 'again' });

    expect((await Call.findById(call._id).lean()).status).toBe('missed');
    expect(
      (await Notification.find().lean()).map((item) => [item.type, item.title, item.link]),
    ).toEqual([['call_missed', 'Missed call from Asha Verma', `/pipeline/${leadId}`]]);
    const tasks = await Task.find().lean();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      title: 'Call back Asha Verma',
      type: 'call',
      priority: 'high',
      source: 'system',
    });
    expect(String(tasks[0].assigneeId)).toBe(String(agent._id));
    expect((await Activity.findOne({ type: 'CALL' }).lean()).title).toBe(
      'Call from Asha Verma · missed',
    );
  });

  it('a number nobody knows goes to the default person; without one the caller is told', async () => {
    const nobody = await ring('919111111111');
    expect(nobody.text).toContain('<Speak>');
    expect(nobody.text).not.toContain('<Dial');
    await hook('hangup', { CallUUID: 'inbound-1', CallStatus: 'completed' });
    expect(await Call.findOne().lean()).toMatchObject({
      status: 'missed',
      fromNumber: '+919111111111',
    });
    // Nobody to tell, and no record to put it on.
    expect(await Notification.countDocuments()).toBe(0);
    expect(await Activity.countDocuments({ type: 'CALL' })).toBe(0);

    const ceo = await User.findOne({ email: 'ceo@engenx.in' }).lean();
    await asCeo.patch('/api/settings/calls').send({ defaultInboundUserId: String(ceo._id) });
    const routed = await ring('919222222222', 'inbound-2');
    expect(routed.text).toContain('<Number>919000000001</Number>');
    const call = await Call.findOne({ plivoCallUuid: 'inbound-2' }).lean();
    await hook(
      'dial-result',
      { CallUUID: 'inbound-2', DialStatus: 'no-answer' },
      { call: call._id },
    );
    await hook('hangup', { CallUUID: 'inbound-2', CallStatus: 'completed' });
    const missed = await Notification.findOne().lean();
    expect(missed).toMatchObject({
      title: 'Missed call from +919222222222',
      body: 'A number that is not in the CRM',
    });
    expect((await Task.findOne().lean()).title).toBe('Call back +919222222222');
  });
});

describe('recordings, outcome and settings', () => {
  it('with recording on, the call is recorded with an announcement and the file is kept', async () => {
    const saved = await asCeo
      .patch('/api/settings/calls')
      .send({ recordingEnabled: true, consentText: 'This call is recorded for training.' });
    expect(saved.status).toBe(200);
    const call = (await startCall(asAgent)).body.data;
    const connect = await hook('connect', { CallUUID: 'request-1' }, { call: call.id });
    expect(connect.text).toContain('<Record');
    expect(connect.text).toContain(`recording?call=${call.id}`);
    expect(connect.text).toContain(
      'confirmSound="https://api.example.test/api/webhooks/plivo/consent"',
    );
    const consent = await hook('consent', {});
    expect(consent.text).toContain('<Speak>This call is recorded for training.</Speak>');

    await hook(
      'recording',
      {
        CallUUID: 'request-1',
        RecordingID: 'rec-1',
        RecordUrl: 'https://media.plivo.example/rec-1.mp3',
      },
      { call: call.id },
    );
    expect(stored.get(`recordings/${call.id}.mp3`).toString()).toBe('mp3-bytes');
    const kept = await Call.findById(call.id).lean();
    expect(kept.recordingConsentPlayed).toBe(true);
    expect(kept.recordingUrl).toBe(`${BUCKET_URL}recordings/${call.id}.mp3`);

    // The agent listens to their own call; opening it is written down. The other agent cannot.
    const link = await asAgent.get(`/api/calls/${call.id}/recording`);
    expect(link.body.data.url).toBe(`${BUCKET_URL}recordings/${call.id}.mp3?X-Amz-Signature=test`);
    expect(await AuditLog.countDocuments({ action: 'call.recording_opened' })).toBe(1);
    expect((await asOther.get(`/api/calls/${call.id}/recording`)).status).toBe(404);
    expect((await asCeo.get(`/api/calls/${call.id}/recording`)).status).toBe(200);
    const listed = (await asAgent.get(`/api/calls?contactId=${contactId}`)).body.data[0];
    expect(listed).toMatchObject({ hasRecording: true, permissions: { canPlayRecording: true } });
  });

  it('the agent says what came of their call; nobody else’s call can be changed', async () => {
    const call = (await startCall(asAgent)).body.data;
    const set = await asAgent
      .patch(`/api/calls/${call.id}`)
      .send({ outcome: 'callback_requested' });
    expect(set.body.data.outcome).toBe('callback_requested');
    expect(
      (await asAgent.patch(`/api/calls/${call.id}`).send({ outcome: 'nonsense' })).status,
    ).toBe(400);
    expect(
      (await asOther.patch(`/api/calls/${call.id}`).send({ outcome: 'connected' })).status,
    ).toBe(404);
    expect(
      (await asAgent.patch(`/api/calls/${call.id}`).send({ outcome: null })).body.data.outcome,
    ).toBeNull();
    // The list of one record needs that record to be visible.
    // (Until 2026-10-12 a list without a record was refused; it is now the list of my calls.)
    expect((await asAgent.get('/api/calls')).body.data).toHaveLength(1);
    expect((await asOther.get('/api/calls')).body.data).toHaveLength(0);
    expect((await asOther.get(`/api/calls?opportunityId=${leadId}`)).status).toBe(404);
  });

  it('Settings → Calls: shows the setup, and is for people who manage the settings', async () => {
    const settings = (await asCeo.get('/api/settings/calls')).body.data;
    expect(settings).toMatchObject({
      recordingEnabled: false,
      consentText: 'This call may be recorded for quality and training.',
      defaultInboundUserId: null,
      canStoreRecordings: true,
      setup: {
        isConfigured: true,
        missing: [],
        inboundPath: '/api/webhooks/plivo/inbound',
        hangupPath: '/api/webhooks/plivo/hangup',
      },
    });
    expect(settings.users.map((user) => [user.name, user.hasPhone])).toEqual([
      ['Asha Agent', true],
      ['Kunal CEO', true],
      ['Omar Agent', false],
    ]);
    // The default person needs a phone; an announcement needs words.
    const omar = await User.findOne({ email: 'other@engenx.in' }).lean();
    expect(
      (await asCeo.patch('/api/settings/calls').send({ defaultInboundUserId: String(omar._id) }))
        .status,
    ).toBe(400);
    expect((await asCeo.patch('/api/settings/calls').send({ consentText: '' })).status).toBe(400);
    expect((await asAgent.get('/api/settings/calls')).status).toBe(403);
    expect(
      (await asAgent.patch('/api/settings/calls').send({ recordingEnabled: true })).status,
    ).toBe(403);
  });
});

describe('recording without the announcement, the list of every call, and re-linking', () => {
  it('with the announcement switched off the call is recorded and nothing is said', async () => {
    await asCeo
      .patch('/api/settings/calls')
      .send({ recordingEnabled: true, announcementEnabled: false });
    expect((await asCeo.get('/api/settings/calls')).body.data.announcementEnabled).toBe(false);
    const call = (await startCall(asAgent)).body.data;
    const connect = await hook('connect', { CallUUID: 'request-1' }, { call: call.id });
    expect(connect.text).toContain('<Record');
    expect(connect.text).not.toContain('confirmSound');
    expect((await Call.findById(call.id).lean()).recordingConsentPlayed).toBe(false);
  });

  it('a call from an unknown number is in the list of calls and can be put on a person', async () => {
    const ceo = await User.findOne({ email: 'ceo@engenx.in' }).lean();
    await asCeo.patch('/api/settings/calls').send({ defaultInboundUserId: String(ceo._id) });
    await hook('inbound', { CallUUID: 'inbound-9', From: '919333333333', To: '918035000000' });
    const stored = await Call.findOne({ plivoCallUuid: 'inbound-9' }).lean();
    await hook(
      'dial-result',
      {
        CallUUID: 'inbound-9',
        DialStatus: 'completed',
        DialBLegDuration: '40',
        DialBLegTotalCost: '0.4',
      },
      { call: stored._id },
    );
    await hook('hangup', { CallUUID: 'inbound-9', CallStatus: 'completed' });
    expect(await Activity.countDocuments({ type: 'CALL' })).toBe(0);

    // The CEO took it: it is in their list, under "belongs to nobody". Not in an agent's list.
    const unknown = (await asCeo.get('/api/calls?linked=no')).body.data;
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatchObject({ number: '+919333333333', contact: null, cost: 0.4 });
    expect((await asAgent.get('/api/calls?linked=no')).body.data).toHaveLength(0);
    expect((await asCeo.get('/api/calls?linked=yes')).body.data).toHaveLength(0);

    // The CEO says who it was: the call, its lead and its timeline entry follow.
    const linked = await asCeo.patch(`/api/calls/${unknown[0].id}`).send({ contactId });
    expect(linked.status).toBe(200);
    expect(linked.body.data).toMatchObject({
      contact: { name: 'Asha Verma' },
      opportunityId: leadId,
    });
    const entry = await Activity.findOne({ type: 'CALL' }).lean();
    expect(entry.title).toBe('Call from Asha Verma · 0:40');
    expect(String(entry.opportunityId)).toBe(leadId);
    expect(await AuditLog.countDocuments({ action: 'call.relinked' })).toBe(1);

    // Taken off again: the entry leaves the timeline; the call stays.
    await asCeo.patch(`/api/calls/${unknown[0].id}`).send({ contactId: null });
    expect(await Activity.countDocuments({ type: 'CALL' })).toBe(0);
    expect((await asCeo.get('/api/calls?linked=no')).body.data).toHaveLength(1);
    // A person outside my reach cannot be chosen, and nothing can be sent empty.
    expect((await asOther.patch(`/api/calls/${unknown[0].id}`).send({ contactId })).status).toBe(
      404,
    );
    expect((await asCeo.patch(`/api/calls/${unknown[0].id}`).send({})).status).toBe(400);
  });
});

describe('inbound: the next person when the first does not pick up', () => {
  const ring = (uuid) =>
    hook('inbound', { CallUUID: uuid, From: '919876543210', To: '918035000000' });
  const callOf = (uuid) => Call.findOne({ plivoCallUuid: uuid }).lean();

  it('rings the default person after the owner; whoever picks up is written down', async () => {
    const ceo = await User.findOne({ email: 'ceo@engenx.in' }).lean();
    await asCeo.patch('/api/settings/calls').send({ defaultInboundUserId: String(ceo._id) });

    // The owner (the agent) is rung first, for a shorter time.
    const first = await ring('inbound-a');
    expect(first.text).toContain('<Number>919000000002</Number>');
    expect(first.text).toContain('timeout="25"');
    const call = await callOf('inbound-a');
    expect(String(call.fallbackUserId)).toBe(String(ceo._id));

    // Nobody picks up: Plivo is told to ring the default person. The call is not over yet.
    const next = await hook(
      'dial-result',
      { CallUUID: 'inbound-a', DialStatus: 'no-answer' },
      { call: `${call._id}&step=1` },
    );
    expect(next.text).toContain('<Number>919000000001</Number>');
    expect(next.text).toContain('step=2');
    expect((await callOf('inbound-a')).status).toBe('ringing');

    await hook(
      'dial-result',
      { CallUUID: 'inbound-a', DialStatus: 'completed', DialBLegDuration: '30' },
      { call: `${call._id}&step=2` },
    );
    await hook('hangup', { CallUUID: 'inbound-a', CallStatus: 'completed' });
    const ended = await callOf('inbound-a');
    expect(ended).toMatchObject({ status: 'completed', durationSec: 30 });
    expect(String(ended.answeredByUserId)).toBe(String(ceo._id));
    expect(String(ended.userId)).toBe(String(agent._id)); // still the owner's customer
    expect(await Notification.countDocuments()).toBe(0);
    const listed = (await asAgent.get(`/api/calls?opportunityId=${leadId}`)).body.data[0];
    expect(listed).toMatchObject({
      user: { name: 'Asha Agent' },
      answeredBy: { name: 'Kunal CEO' },
    });

    // Both do not pick up: a missed call for the owner, once.
    await ring('inbound-b');
    const second = await callOf('inbound-b');
    await hook(
      'dial-result',
      { CallUUID: 'inbound-b', DialStatus: 'no-answer' },
      { call: `${second._id}&step=1` },
    );
    await hook(
      'dial-result',
      { CallUUID: 'inbound-b', DialStatus: 'no-answer' },
      { call: `${second._id}&step=2` },
    );
    await hook('hangup', { CallUUID: 'inbound-b', CallStatus: 'completed' });
    expect((await callOf('inbound-b')).status).toBe('missed');
    const told = await Notification.find().lean();
    expect(told).toHaveLength(1);
    expect(String(told[0].userId)).toBe(String(agent._id));
  });

  it('without a default person the owner’s manager is next; with neither, nobody', async () => {
    const plain = await ring('inbound-c');
    expect(plain.text).not.toContain('timeout="25"');
    const call = await callOf('inbound-c');
    expect(call.fallbackUserId).toBeUndefined();
    const nothing = await hook(
      'dial-result',
      { CallUUID: 'inbound-c', DialStatus: 'no-answer' },
      { call: `${call._id}&step=1` },
    );
    expect(nothing.text).not.toContain('<Dial');

    const ceo = await User.findOne({ email: 'ceo@engenx.in' }).lean();
    await User.updateOne({ _id: agent._id }, { $set: { managerId: ceo._id } });
    await ring('inbound-d');
    expect(String((await callOf('inbound-d')).fallbackUserId)).toBe(String(ceo._id));
  });
});

describe('the call log', () => {
  const HOUR = 60 * 60 * 1000;
  let mine; // the agent's talked call with the customer
  let other; // Omar's missed call from an unknown number

  beforeEach(async () => {
    const contact = await Contact.findById(contactId).lean();
    const omar = await User.findOne({ email: 'other@engenx.in' }).lean();
    mine = await Call.create({
      plivoCallUuid: 'a-leg-1',
      direction: 'outbound',
      fromNumber: '+918035000000',
      toNumber: '+919876543210',
      status: 'completed',
      startedAt: new Date(Date.now() - 2 * HOUR),
      endedAt: new Date(Date.now() - 2 * HOUR + 60000),
      durationSec: 31,
      cost: 0.00474,
      userId: agent._id,
      contactId: contact._id,
      accountId: contact.accountId,
      opportunityId: leadId,
      outcome: 'callback_requested',
      recordingUrl: `${BUCKET_URL}recordings/x.mp3`,
      plivo: {
        dial: {
          DialStatus: 'completed',
          DialBLegTo: '919876543210',
          DialHangupCause: 'NORMAL_CLEARING',
        },
        hangup: {
          StartTime: '2026-10-12 14:55:41',
          AnswerTime: '2026-10-12 14:55:48',
          EndTime: '2026-10-12 14:56:01',
          To: '919000000002',
          Duration: '14',
          TotalCost: '0.00237',
          HangupCauseName: 'Normal Hangup',
          HangupSource: 'Callee',
        },
        aLeg: { durationSec: 14, cost: 0.00237, hangupCause: 'Normal Hangup' },
        bLeg: { durationSec: 8, cost: 0.00237, hangupCause: 'Normal Hangup' },
        settledAt: new Date(),
      },
    });
    other = await Call.create({
      direction: 'inbound',
      fromNumber: '+919333333333',
      toNumber: '+918035000000',
      status: 'missed',
      startedAt: new Date(Date.now() - 30 * HOUR),
      endedAt: new Date(Date.now() - 30 * HOUR),
      durationSec: 0,
      userId: omar._id,
    });
  });
  const log = async (client, query = '') => (await client.get(`/api/calls${query}`)).body;

  it('shows each person the calls of their scope, with company, person, lead and charge', async () => {
    const all = await log(asCeo);
    expect(all.meta.total).toBe(2);
    expect(all.data[0]).toMatchObject({
      direction: 'outbound',
      status: 'completed',
      number: '+919876543210',
      durationSec: 31,
      costInr: 0.38,
      outcome: 'callback_requested',
      user: { name: 'Asha Agent' },
      contact: { name: 'Asha Verma' },
      account: { name: 'Bharat Forge' },
      lead: { name: 'OEE for press line' },
      hasRecording: true,
    });
    // An agent sees only their own calls.
    expect((await log(asAgent)).data.map((call) => call.id)).toEqual([String(mine._id)]);
    expect((await log(asOther)).data.map((call) => call.id)).toEqual([String(other._id)]);
    // Whose calls can be filtered by.
    expect((await asCeo.get('/api/calls/form-options')).body.data.users).toHaveLength(3);
    expect((await asAgent.get('/api/calls/form-options')).body.data.users).toEqual([
      { id: String(agent._id), name: 'Asha Agent' },
    ]);
  });

  it('is filtered, searched and sorted on the server', async () => {
    const ids = async (query) => (await log(asCeo, query)).data.map((call) => String(call.id));
    expect(await ids('?direction=inbound')).toEqual([String(other._id)]);
    expect(await ids('?status=completed')).toEqual([String(mine._id)]);
    expect(await ids('?outcome=callback_requested')).toEqual([String(mine._id)]);
    expect(await ids(`?userId=${agent._id}`)).toEqual([String(mine._id)]);
    expect(await ids('?recording=yes')).toEqual([String(mine._id)]);
    expect(await ids('?linked=no')).toEqual([String(other._id)]);
    expect(await ids('?range=today')).toEqual([String(mine._id)]);
    // By the name of the person, the company or the lead, and by a part of the number.
    expect(await ids('?search=verma')).toEqual([String(mine._id)]);
    expect(await ids('?search=bharat')).toEqual([String(mine._id)]);
    expect(await ids('?search=press line')).toEqual([String(mine._id)]);
    expect(await ids('?search=93333')).toEqual([String(other._id)]);
    expect(await ids('?search=nothing-like-this')).toEqual([]);
    expect(await ids('?sort=durationSec')).toEqual([String(other._id), String(mine._id)]);
    expect(await ids('?sort=-startedAt&pageSize=1&page=2')).toEqual([String(other._id)]);
    expect((await asCeo.get('/api/calls?status=nonsense')).status).toBe(400);
    // A search never widens what an agent may see.
    expect((await log(asOther, '?search=verma')).data).toEqual([]);
  });

  it('one call in full: its times, both sides with length and charge, and what happened', async () => {
    const detail = (await asAgent.get(`/api/calls/${mine._id}`)).body.data;
    expect(detail).toMatchObject({
      fromNumber: '+918035000000',
      toNumber: '+919876543210',
      startedAt: '2026-10-12T14:55:41.000Z',
      answeredAt: '2026-10-12T14:55:48.000Z',
      endedAt: '2026-10-12T14:56:01.000Z',
      ringSec: 7,
      hangupCauseName: 'Normal Hangup',
      hangupSource: 'Callee',
      costInr: 0.38,
      isSettled: true,
      raw: null, // Plivo's own words are for people who manage the settings
    });
    expect(detail.legs).toEqual([
      {
        relation: 'First side',
        from: '+918035000000',
        to: '+919000000002',
        who: 'Our person’s phone',
        durationSec: 14,
        costInr: 0.19,
        hangupCause: 'Normal Hangup',
      },
      {
        relation: 'Second side',
        from: '+918035000000',
        to: '+919876543210',
        who: 'The customer',
        durationSec: 8,
        costInr: 0.19,
        hangupCause: 'Normal Hangup',
      },
    ]);
    expect(detail.events.map((event) => event.what)).toContain(
      'The call ended (hung up by: Callee)',
    );
    expect((await asCeo.get(`/api/calls/${mine._id}`)).body.data.raw.hangup.Duration).toBe('14');
    // Somebody else's call is "not found".
    expect((await asOther.get(`/api/calls/${mine._id}`)).status).toBe(404);
    expect((await asAgent.get('/api/calls/not-an-id')).status).toBe(400);
  });
});

describe('calls inside the CRM (the browser)', () => {
  const signIn = async (client) => (await client.get('/api/calls/browser-phone')).body.data;
  // As Plivo really sends it for a browser signed in with a token (seen on production,
  // 2026-10-17): the endpoint's name, "_" and a code of that sign-in.
  const fromBrowser = (username, callId, to = '919876543210', uuid = 'browser-1') =>
    hook('inbound', {
      CallUUID: uuid,
      From: `sip:${username}_Ab12Cd34Ef56Gh78Ij90@phone.plivo.com`,
      To: to,
      'X-PH-CallId': callId,
      'SIP-H-To': `<sip:${to}@phone.plivo.com>`,
    });

  it('each person signs in with their own endpoint, made once, for a day', async () => {
    const first = await signIn(asAgent);
    expect(first).toMatchObject({ isAvailable: true, ringtoneUrl: null });
    expect(first.token).toMatch(/^jwt-for-crm/);
    expect(new Date(first.expiresAt).getTime() - Date.now()).toBeGreaterThan(23 * 3600 * 1000);
    await signIn(asAgent);
    expect(endpoints).toHaveLength(1); // made once
    expect(endpoints[0].alias).toBe(`crm-${agent._id}`);
    expect(tokens.map((item) => item.username)).toEqual([
      endpoints.length && first.token.slice('jwt-for-'.length),
      first.token.slice('jwt-for-'.length),
    ]);
    // The token is never kept with the person.
    const stored = await User.findById(agent._id).lean();
    expect(stored.plivoEndpoint).toMatchObject({ id: 'ep-1' });
    expect(JSON.stringify(stored)).not.toContain('jwt-for');
    expect((await request(app).get('/api/calls/browser-phone')).status).toBe(401);

    // Switched off in Settings → Calls: no browser, and a call from it is refused.
    await asCeo.patch('/api/settings/calls').send({ browserCallingEnabled: false });
    expect(await signIn(asAgent)).toEqual({ isAvailable: false });
    expect((await asAgent.post('/api/calls/browser').send({ contactId })).status).toBe(409);
  });

  it('a call from the browser dials only the number the CRM wrote for that person', async () => {
    const username = (await signIn(asAgent)).token.slice('jwt-for-'.length);
    // Somebody who may not see the contact cannot start it.
    expect(
      (await asOther.post('/api/calls/browser').send({ contactId, opportunityId: leadId })).status,
    ).toBe(404);
    const started = await asAgent
      .post('/api/calls/browser')
      .send({ contactId, opportunityId: leadId });
    expect(started.status).toBe(201);
    expect(started.body.data).toMatchObject({ to: '+919876543210' });
    const { callId } = started.body.data;
    expect(placed).toHaveLength(0); // no phone is rung

    // Another browser, a wrong number or no call id: ended at once, nothing dialled.
    for (const [user, id, to] of [
      ['crmsomeoneelse', callId, '919876543210'],
      [username, callId, '919111111111'],
      [username, 'not-an-id', '919876543210'],
    ]) {
      const refused = await fromBrowser(user, id, to, `refused-${user}-${to}`);
      expect(refused.text).not.toContain('<Dial');
    }

    const answer = await fromBrowser(username, callId);
    expect(answer.text).toContain('<Dial');
    expect(answer.text).toContain('callerId="918035000000"');
    expect(answer.text).toContain('<Number>919876543210</Number>');
    // Only the customer is dialled: nobody's phone, and it is not taken for a customer's call.
    expect(answer.text).not.toContain('<Number>91900000000');
    expect(await Call.countDocuments({ direction: 'inbound' })).toBe(0);
    expect(answer.text).toContain(`dial-result?call=${callId}`);
    // Asked again: not dialled twice.
    const again = await fromBrowser(username, callId, '919876543210', 'browser-1b');
    expect(again.text).not.toContain('<Dial');

    // The customer talks; the call ends as every other call does.
    await hook(
      'dial-result',
      { CallUUID: 'browser-1', DialStatus: 'completed', DialBLegUUID: 'b-leg-1' },
      { call: callId },
    );
    await hook('hangup', { CallUUID: 'browser-1', Duration: '75', TotalCost: '0.004' });
    const done = await Call.findById(callId).lean();
    expect(done).toMatchObject({
      via: 'browser',
      status: 'completed',
      plivoCallUuid: 'browser-1',
    });
    const detail = (await asAgent.get(`/api/calls/${callId}`)).body.data;
    expect(detail.legs[0].who).toBe('Our person, in the CRM');
    expect((await Activity.find({ type: 'CALL' }).lean()).map((entry) => entry.title)).toEqual([
      'Call to Asha Verma · 1:15',
    ]);

    // The plain form of From is understood as well.
    const plain = (await asAgent.post('/api/calls/browser').send({ contactId })).body.data.callId;
    const plainAnswer = await hook('inbound', {
      CallUUID: 'browser-plain',
      From: `sip:${username}@phone.plivo.com`,
      To: '919876543210',
      'X-PH-CallId': plain,
    });
    expect(plainAnswer.text).toContain('<Number>919876543210</Number>');
    // A call id from something that is not one of our browsers: ended, never taken for a
    // customer's call (no phone of ours rings).
    const odd = (await asAgent.post('/api/calls/browser').send({ contactId })).body.data.callId;
    const oddAnswer = await hook('inbound', {
      CallUUID: 'browser-odd',
      From: '919333333333',
      To: '919876543210',
      'X-PH-CallId': odd,
    });
    expect(oddAnswer.text).not.toContain('<Dial');
    expect(await Call.countDocuments({ direction: 'inbound' })).toBe(0);

    // A call the browser did not use in time is refused.
    const late = (await asAgent.post('/api/calls/browser').send({ contactId })).body.data.callId;
    // (Straight in the collection: Mongoose keeps createdAt as it was.)
    await Call.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(late) },
      { $set: { createdAt: new Date(Date.now() - 5 * 60000) } },
    );
    expect((await fromBrowser(username, late, '919876543210', 'browser-late')).text).not.toContain(
      '<Dial',
    );
  });

  it('a call from the browser that never reached Plivo does not stay “starting” for ever', async () => {
    await signIn(asAgent);
    const { callId } = (await asAgent.post('/api/calls/browser').send({ contactId })).body.data;
    await settleWaitingCalls(new Date(Date.now() + 5 * 60 * 1000));
    expect((await Call.findById(callId).lean()).status).toBe('initiated');
    await settleWaitingCalls(new Date(Date.now() + 11 * 60 * 1000));
    expect(await Call.findById(callId).lean()).toMatchObject({
      status: 'failed',
      hangupCause: 'never_reached_plivo',
    });
  });

  it('a customer’s call rings the browser and the phone together', async () => {
    const username = (await signIn(asAgent)).token.slice('jwt-for-'.length);
    const answer = await hook('inbound', {
      CallUUID: 'both-1',
      From: '919876543210',
      To: '918035000000',
    });
    const call = await Call.findOne({ plivoCallUuid: 'both-1' }).lean();
    expect(answer.text).toContain(
      `<User sipHeaders="CallId=${call._id}">sip:${username}@phone.plivo.com</User>`,
    );
    expect(answer.text).toContain('<Number>919000000002</Number>');

    // Without a phone the browser alone rings; with the browser switched off, the phone alone.
    await User.updateOne({ _id: agent._id }, { $unset: { phone: '' } });
    const browserOnly = await hook('inbound', {
      CallUUID: 'both-2',
      From: '919876543210',
      To: '918035000000',
    });
    expect(browserOnly.text).toContain('<User');
    expect(browserOnly.text).not.toContain('<Number>919000000002</Number>');
    await User.updateOne({ _id: agent._id }, { $set: { phone: '+919000000002' } });
    await asCeo.patch('/api/settings/calls').send({ browserCallingEnabled: false });
    const phoneOnly = await hook('inbound', {
      CallUUID: 'both-3',
      From: '919876543210',
      To: '918035000000',
    });
    expect(phoneOnly.text).not.toContain('<User');
    expect(phoneOnly.text).toContain('<Number>919000000002</Number>');
  });

  it('our own ringtone is set in Settings → Calls by who manages the settings', async () => {
    const upload = (client, type = 'audio/mpeg', name = 'bell.mp3') =>
      client
        .post('/api/settings/calls/ringtone')
        .attach('file', Buffer.from('ID3 bell'), { filename: name, contentType: type });
    expect((await upload(asAgent)).status).toBe(403);
    expect((await upload(asCeo, 'text/plain', 'bell.txt')).status).toBe(400);
    const saved = await upload(asCeo);
    expect(saved.status).toBe(200);
    expect(saved.body.data.ringtone.name).toMatch(/bell\.mp3$/);
    expect(saved.body.data.ringtone.url).toContain('X-Amz-Signature');
    expect([...stored.keys()].some((key) => key.startsWith('ringtones/'))).toBe(true);
    // Every browser gets it with its sign-in.
    expect((await signIn(asAgent)).ringtoneUrl).toContain('ringtones/');

    const removed = await asCeo.delete('/api/settings/calls/ringtone');
    expect(removed.body.data.ringtone).toBeNull();
    expect((await signIn(asAgent)).ringtoneUrl).toBeNull();
  });
});
