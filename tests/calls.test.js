import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// The Plivo settings exist only for this test file; they are set before the app reads them.
Object.assign(process.env, {
  PLIVO_AUTH_ID: 'test-auth-id',
  PLIVO_AUTH_TOKEN: 'test-auth-token',
  PLIVO_NUMBER: '918035000000',
  API_PUBLIC_URL: 'https://api.example.test',
});

// Plivo itself is replaced: starting a call is collected here, a webhook counts as signed when
// it carries the test header, and a recording "download" gives a few bytes. The XML answers
// are the real ones.
const placed = [];
let plivoFails = false;
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
const { Notification } = await import('../models/notification.model.js');
const { Role } = await import('../models/role.model.js');
const { Task } = await import('../models/task.model.js');
const { User } = await import('../models/user.model.js');
const { WebhookEvent } = await import('../models/webhookEvent.model.js');
const { runSeed, seedStartingLists, seedStatusLists } = await import('../seeds/seed.js');
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
    // A list needs one record to be about, and that record must be visible.
    expect((await asAgent.get('/api/calls')).status).toBe(400);
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
