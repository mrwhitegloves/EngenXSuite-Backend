import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// The meeting recorder (Chrome extension) and meeting transcripts: pairing, start, pieces of
// speech, reading them (the AI is replaced by prepared answers), the transcript in the CRM,
// echoes, corrections, the AI summary from the transcript, and pasted outside analyses.
process.env.OPENROUTER_API_KEY = 'test-openrouter-key';

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

// What the audio-to-text model "hears", one answer per piece, in order.
let heard = [];
let transcribeCalls = 0;
let chatAnswers = [];
let chatRequests = [];
vi.stubGlobal('fetch', async (input, options = {}) => {
  const url = String(input);
  const json = (body) => new Response(JSON.stringify(body), { status: 200 });
  if (url.endsWith('/audio/transcriptions')) {
    transcribeCalls += 1;
    return json({ text: heard.shift() ?? '', usage: { seconds: 5, cost: 0.0004 } });
  }
  if (!url.includes('openrouter.ai')) return json({});
  const body = JSON.parse(options.body);
  chatRequests.push({ system: body.messages[0].content, user: body.messages.at(-1).content });
  return json({
    model: body.models[0],
    choices: [{ message: { content: JSON.stringify(chatAnswers.shift()) } }],
    usage: { prompt_tokens: 300, completion_tokens: 200, cost: 0.001 },
  });
});

const { createApp } = await import('../app.js');
const { createSessionMiddleware } = await import('../middleware/session.js');
const { Activity } = await import('../models/activity.model.js');
const { AiUsageDaily } = await import('../models/aiUsage.model.js');
const { AuditLog } = await import('../models/auditLog.model.js');
const { Meeting } = await import('../models/meeting.model.js');
const { MeetingRecording } = await import('../models/meetingRecording.model.js');
const { MeetingTranscriptSegment } = await import('../models/meetingTranscriptSegment.model.js');
const { Notification } = await import('../models/notification.model.js');
const { RecorderDevice } = await import('../models/recorderDevice.model.js');
const { Role } = await import('../models/role.model.js');
const { User } = await import('../models/user.model.js');
const service = await import('../services/meetingTranscripts.service.js');
const { runSeed, seedStartingLists, seedStatusLists } = await import('../seeds/seed.js');
const { clearTestDb, startTestDbWithTransactions, stopTestDb } =
  await import('./helpers/testDb.js');

const PASSWORD = 'correct-horse-battery';
const HOUR = 60 * 60 * 1000;
const MEET = 'abc-defg-hij';
let app;
let asAsha;
let asOmar;
let asCeo;
let asha;
let leadId;
let accountId;
let meetingId;

/** A real WAV file: 16 kHz, 16-bit, mono, `ms` long (silence; the model's answer is prepared). */
function wav(ms = 2000) {
  const samples = Math.round((16000 * ms) / 1000);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}

async function signedInAs(user) {
  const client = request.agent(app);
  const response = await client
    .post('/api/auth/login')
    .send({ email: user.email, password: PASSWORD });
  expect(response.status).toBe(200);
  return client;
}

/** Pair a recorder for a signed-in person; returns a function that calls with its token. */
async function pairedRecorder(client) {
  const code = (await client.post('/api/recorder/pairing-codes')).body.data.code;
  const paired = await request(app)
    .post('/api/recorder/pair')
    .set('Origin', 'chrome-extension://abcdefghijklmnop')
    .set('Sec-Fetch-Site', 'cross-site')
    .send({ code: code.toLowerCase().replace(/(.{4})/, '$1-'), deviceName: 'Chrome on Windows' });
  expect(paired.status).toBe(200);
  const token = paired.body.data.token;
  const call = (method, path) => {
    const agent = request(app);
    return agent[method](`/api/recorder${path}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Origin', 'chrome-extension://abcdefghijklmnop')
      .set('Sec-Fetch-Site', 'cross-site');
  };
  return { token, call };
}

const sendPiece = (call, recordingId, { key, track = 'tab', at = Date.now(), ms = 2000 }) =>
  call(
    'post',
    `/recordings/${recordingId}/segments?clientKey=${key}&track=${track}&startedAt=${at}`,
  )
    .set('Content-Type', 'audio/wav')
    .send(wav(ms));

beforeAll(async () => {
  await startTestDbWithTransactions(); // creating a lead uses a transaction
  app = createApp({ sessionMiddleware: createSessionMiddleware() });
});
afterAll(stopTestDb);

beforeEach(async () => {
  await clearTestDb();
  stored.clear();
  heard = [];
  transcribeCalls = 0;
  chatAnswers = [];
  chatRequests = [];
  await runSeed({ productName: 'P', companyName: 'C', workspaceDomain: 'engenx.in' });
  await seedStatusLists();
  await seedStartingLists();
  const roles = Object.fromEntries((await Role.find()).map((role) => [role.name, role]));
  const makeUser = (email, name, roleName) =>
    User.create({ email, name, roleId: roles[roleName]._id, status: 'active', password: PASSWORD });
  const users = await Promise.all([
    makeUser('asha@engenx.in', 'Asha Agent', 'Sales Agent'),
    makeUser('omar@engenx.in', 'Omar Agent', 'Sales Agent'),
    makeUser('ceo@engenx.in', 'Kunal CEO', 'CEO'),
  ]);
  asha = users[0];
  [asAsha, asOmar, asCeo] = await Promise.all(users.map(signedInAs));
  const created = await asAsha.post('/api/accounts/quick-add').send({
    account: { name: 'Bharat Forge' },
    contacts: [{ name: 'Asha Verma', email: 'asha.verma@bharatforge.example' }],
    lead: { name: 'OEE for press line' },
  });
  leadId = created.body.data.lead.id;
  accountId = created.body.data.account.id;
  const meeting = await asAsha.post('/api/meetings').send({
    title: 'Pilot scope',
    mode: 'online',
    startAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    endAt: new Date(Date.now() + HOUR).toISOString(),
    opportunityId: leadId,
  });
  meetingId = meeting.body.data.id;
  // As Google Calendar would have given it.
  await Meeting.updateOne(
    { _id: meetingId },
    { $set: { meetLink: `https://meet.google.com/${MEET}` } },
  );
});

describe('connecting a recorder', () => {
  it('a code is used once; the token signs in as the person; it can be disconnected', async () => {
    const code = (await asAsha.post('/api/recorder/pairing-codes')).body.data.code;
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    const pair = (body) =>
      request(app)
        .post('/api/recorder/pair')
        .set('Origin', 'chrome-extension://abcdefghijklmnop')
        .set('Sec-Fetch-Site', 'cross-site')
        .send(body);
    expect((await pair({ code: 'WRONGCODE' })).status).toBe(400);
    const paired = await pair({ code });
    expect(paired.status).toBe(200);
    expect(paired.body.data.user).toEqual({ name: 'Asha Agent', email: 'asha@engenx.in' });
    expect((await pair({ code })).status).toBe(400); // used once

    // Only a hash is stored.
    const device = await RecorderDevice.findOne({ userId: asha._id }).lean();
    expect(device.tokenHash).toHaveLength(64);
    expect(JSON.stringify(device)).not.toContain(paired.body.data.token);

    const token = paired.body.data.token;
    const me = await request(app).get('/api/recorder/me').set('Authorization', `Bearer ${token}`);
    expect(me.body.data.user.name).toBe('Asha Agent');
    expect((await request(app).get('/api/recorder/me')).status).toBe(401);
    expect(
      (await request(app).get('/api/recorder/me').set('Authorization', 'Bearer rec_nope')).status,
    ).toBe(401);

    const list = await asAsha.get('/api/recorder/devices');
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].name).toBe('Meeting recorder');
    // Another person cannot disconnect it.
    expect((await asOmar.delete(`/api/recorder/devices/${list.body.data[0].id}`)).status).toBe(404);
    expect((await asAsha.delete(`/api/recorder/devices/${list.body.data[0].id}`)).status).toBe(200);
    expect(
      (await request(app).get('/api/recorder/me').set('Authorization', `Bearer ${token}`)).status,
    ).toBe(401);
  });

  it('a deactivated user’s recorder stops working at once', async () => {
    const { call } = await pairedRecorder(asAsha);
    expect((await call('get', '/me')).status).toBe(200);
    await User.updateOne({ _id: asha._id }, { $set: { status: 'deactivated' } });
    expect((await call('get', '/me')).status).toBe(401);
  });

  it('a recorder request without the token is still refused from another site', async () => {
    const refused = await asAsha
      .post('/api/recorder/pairing-codes')
      .set('Origin', 'https://evil.example')
      .set('Sec-Fetch-Site', 'cross-site');
    expect(refused.status).toBe(403);
  });
});

describe('recording a meeting', () => {
  it('finds the meeting by its Meet code, records, reads the pieces and finishes', async () => {
    const { call } = await pairedRecorder(asAsha);
    const match = await call(
      'get',
      `/meetings/match?code=https://meet.google.com/${MEET}?authuser=0`,
    );
    expect(match.status).toBe(200);
    expect(match.body.data.matched).toMatchObject({
      id: meetingId,
      title: 'Pilot scope',
      account: { name: 'Bharat Forge' },
      lead: { name: 'OEE for press line' },
      activeRecording: null,
    });

    // Without the consent tick nothing starts.
    expect(
      (await call('post', '/recordings').send({ meetCode: MEET, meetingId, consent: false }))
        .status,
    ).toBe(400);
    const started = await call('post', '/recordings').send({
      meetCode: MEET,
      meetingId,
      consent: true,
    });
    expect(started.status).toBe(201);
    const recordingId = started.body.data.recording.id;

    // Starting again (the tab was reloaded) goes on with the same recording.
    const again = await call('post', '/recordings').send({
      meetCode: MEET,
      meetingId,
      consent: true,
    });
    expect(again.body.data.recording.id).toBe(recordingId);
    // A colleague who also sees the meeting is told who records it.
    const ceo = await pairedRecorder(asCeo);
    const busy = await ceo
      .call('post', '/recordings')
      .send({ meetCode: MEET, meetingId, consent: true });
    expect(busy.status).toBe(409);
    expect(busy.body.error.message).toContain('Asha Agent');

    const t0 = Date.now() - 60_000;
    heard = [
      'Hum predictive maintenance chahte hain press number two par.',
      'Ji, hum IoT sensors laga sakte hain.',
      '',
    ];
    expect(
      (await sendPiece(call, recordingId, { key: 's1-tab-1', track: 'tab', at: t0 })).status,
    ).toBe(200);
    expect(
      (await sendPiece(call, recordingId, { key: 's1-mic-1', track: 'mic', at: t0 + 4000 })).status,
    ).toBe(200);
    expect(
      (await sendPiece(call, recordingId, { key: 's1-tab-2', track: 'tab', at: t0 + 9000 })).status,
    ).toBe(200);
    // The same piece sent twice is one piece, read once.
    const twice = await sendPiece(call, recordingId, { key: 's1-tab-1', track: 'tab', at: t0 });
    expect(twice.body.data.duplicate).toBe(true);
    // Without Redis the pieces are read here, in the background.
    await vi.waitFor(async () =>
      expect(
        await MeetingTranscriptSegment.countDocuments({
          status: { $in: ['pending', 'processing'] },
        }),
      ).toBe(0),
    );
    expect(transcribeCalls).toBe(3);
    // The meeting's pieces do not use up the person's daily AI number.
    expect(await AiUsageDaily.countDocuments({ userId: asha._id })).toBe(0);

    // Not a WAV file: refused.
    const junk = await call(
      'post',
      `/recordings/${recordingId}/segments?clientKey=x1&track=tab&startedAt=${t0}`,
    )
      .set('Content-Type', 'audio/wav')
      .send(Buffer.from('not audio at all, really not'));
    expect(junk.status).toBe(400);

    const live = await call('get', `/recordings/${recordingId}/transcript`);
    expect(live.body.data.lines.map((line) => [line.speaker.name, line.text])).toEqual([
      ['Others in the meeting', 'Hum predictive maintenance chahte hain press number two par.'],
      ['Asha Agent', 'Ji, hum IoT sensors laga sakte hain.'],
    ]);

    // In the CRM, while it is still recording: no timeline entry yet.
    const during = await asAsha.get(`/api/meetings/${meetingId}/transcript`);
    expect(during.body.data.isRecording).toBe(true);
    expect(await Activity.countDocuments({ subtype: 'meeting_transcript' })).toBe(0);

    const stopped = await call('post', `/recordings/${recordingId}/stop`).send({});
    expect(stopped.body.data.status).toBe('ready');
    expect(await Activity.countDocuments({ subtype: 'meeting_transcript' })).toBe(1);
    expect(
      await Notification.countDocuments({ userId: asha._id, type: 'meeting_transcript_ready' }),
    ).toBe(1);
    // A stopped recording takes no more pieces.
    expect((await sendPiece(call, recordingId, { key: 's1-tab-9', at: t0 + 20000 })).status).toBe(
      409,
    );
    expect(await AuditLog.countDocuments({ action: 'meeting.recording_started' })).toBe(1);
  });

  it('a Meet call that is not in the CRM becomes a meeting of the chosen company, not in Google', async () => {
    const { call } = await pairedRecorder(asAsha);
    const match = await call('get', '/meetings/match?code=zzz-yyyy-xxx');
    expect(match.body.data.matched).toBeNull();
    expect(match.body.data.today.map((meeting) => meeting.id)).toContain(meetingId);

    const companies = await call('get', '/accounts?search=bharat');
    expect(companies.body.data).toEqual([
      expect.objectContaining({ id: accountId, name: 'Bharat Forge' }),
    ]);
    const leads = await call('get', `/leads?accountId=${accountId}`);
    expect(leads.body.data.map((lead) => lead.id)).toEqual([leadId]);

    const started = await call('post', '/recordings').send({
      meetCode: 'zzz-yyyy-xxx',
      opportunityId: leadId,
      title: 'Quick call',
      consent: true,
    });
    expect(started.status).toBe(201);
    const meeting = await Meeting.findById(started.body.data.meeting.id).lean();
    expect(meeting).toMatchObject({
      title: 'Quick call',
      bookedVia: 'recorder',
      meetLink: 'https://meet.google.com/zzz-yyyy-xxx',
    });
    expect(meeting.googleEventId).toBeUndefined();
    expect(String(meeting.accountId)).toBe(accountId);

    // Omar may not see this company: he cannot choose it, nor record its meeting.
    const omar = await pairedRecorder(asOmar);
    expect((await omar.call('get', '/accounts?search=bharat')).body.data).toEqual([]);
    expect(
      (await omar.call('post', '/recordings').send({ meetCode: MEET, meetingId, consent: true }))
        .status,
    ).toBe(404);
    expect(
      (await omar.call('post', '/recordings').send({ meetCode: MEET, accountId, consent: true }))
        .status,
    ).toBe(404);
  });

  it('a recording that went quiet is finished by the sweep; a piece that fails is retried, then marked', async () => {
    const { call } = await pairedRecorder(asAsha);
    const recordingId = (
      await call('post', '/recordings').send({ meetCode: MEET, meetingId, consent: true })
    ).body.data.recording.id;
    heard = ['Pehla hissa.'];
    await sendPiece(call, recordingId, { key: 'a1', track: 'tab' });
    await vi.waitFor(async () =>
      expect(await MeetingTranscriptSegment.countDocuments({ status: 'done' })).toBe(1),
    );
    // A piece stuck "processing" (the server stopped half way) is read again by the sweep.
    const stuck = await MeetingTranscriptSegment.create({
      recordingId,
      meetingId,
      clientKey: 'a2',
      track: 'mic',
      startedAt: new Date(),
      durationMs: 2000,
      audioUrl: `${BUCKET_URL}x/a2.wav`,
      status: 'processing',
      attempts: 1,
    });
    stored.set('x/a2.wav', wav());
    await MeetingTranscriptSegment.collection.updateOne(
      { _id: stuck._id },
      { $set: { updatedAt: new Date(Date.now() - 10 * 60 * 1000) } },
    );
    heard = ['Doosra hissa.'];
    const later = new Date(Date.now() + 20 * 60 * 1000);
    const swept = await service.runTranscriptSweep(later);
    expect(swept.stoppedIdle).toBe(1);
    expect(swept.requeued).toBe(1);
    await vi.waitFor(async () =>
      expect((await MeetingRecording.findById(recordingId).lean()).status).toBe('ready'),
    );
    expect((await MeetingRecording.findById(recordingId).lean()).stopReason).toBe('idle');

    // Pieces after a quiet stop (the laptop woke up) open the recording again.
    heard = ['Teesra hissa.'];
    expect((await sendPiece(call, recordingId, { key: 'a3', track: 'tab' })).status).toBe(200);
    expect((await MeetingRecording.findById(recordingId).lean()).status).toBe('recording');
  });

  it('Hindi in Devanagari is rewritten in Roman letters', async () => {
    const { call } = await pairedRecorder(asAsha);
    const recordingId = (
      await call('post', '/recordings').send({ meetCode: MEET, meetingId, consent: true })
    ).body.data.recording.id;
    heard = ['बजट कितना है?'];
    chatAnswers = [{ text: 'Budget kitna hai?' }];
    await sendPiece(call, recordingId, { key: 'h1', track: 'tab' });
    await vi.waitFor(async () =>
      expect((await MeetingTranscriptSegment.findOne({ clientKey: 'h1' }).lean()).status).toBe(
        'done',
      ),
    );
    expect((await MeetingTranscriptSegment.findOne({ clientKey: 'h1' }).lean()).text).toBe(
      'Budget kitna hai?',
    );
    expect(chatRequests[0].system).toContain('Transliterate, never translate');
  });
});

describe('the transcript in the CRM', () => {
  async function recordedMeeting() {
    const { call } = await pairedRecorder(asAsha);
    const recordingId = (
      await call('post', '/recordings').send({ meetCode: MEET, meetingId, consent: true })
    ).body.data.recording.id;
    const t0 = Date.now() - 120_000;
    heard = [
      'We lose about two hours a day on press two because of breakdowns.',
      // The laptop's microphone heard the loudspeaker: an echo of the line above.
      'we lose about two hours a day on press two because of breakdowns',
      'We can start with a pilot of vibration sensors in two weeks.',
    ];
    await sendPiece(call, recordingId, { key: 'e1', track: 'tab', at: t0, ms: 4000 });
    await vi.waitFor(async () =>
      expect(await MeetingTranscriptSegment.countDocuments({ status: 'done' })).toBe(1),
    );
    await sendPiece(call, recordingId, { key: 'e2', track: 'mic', at: t0 + 300, ms: 4000 });
    await vi.waitFor(async () =>
      expect(await MeetingTranscriptSegment.countDocuments({ status: 'done' })).toBe(2),
    );
    await sendPiece(call, recordingId, { key: 'e3', track: 'mic', at: t0 + 8000, ms: 3000 });
    await vi.waitFor(async () =>
      expect(await MeetingTranscriptSegment.countDocuments({ status: 'done' })).toBe(3),
    );
    await call('post', `/recordings/${recordingId}/stop`).send({});
    return { call, recordingId };
  }

  it('shows the lines in order, hides the echo, and follows the meeting’s access', async () => {
    await recordedMeeting();
    const transcript = (await asAsha.get(`/api/meetings/${meetingId}/transcript`)).body.data;
    expect(transcript.lines.map((line) => [line.speaker.kind, line.isEcho])).toEqual([
      ['tab', false],
      ['mic', true],
      ['mic', false],
    ]);
    expect(transcript.lines[0].canEdit).toBe(true);
    expect(transcript.recordings[0].recordedBy.name).toBe('Asha Agent');

    const ceoView = await asCeo.get(`/api/meetings/${meetingId}/transcript`);
    expect(ceoView.status).toBe(200);
    expect((await asOmar.get(`/api/meetings/${meetingId}/transcript`)).status).toBe(404);

    const file = await asAsha.get(`/api/meetings/${meetingId}/transcript/download`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('text/plain');
    expect(file.text).toContain('Others in the meeting: We lose about two hours');
    expect(file.text).toContain('Asha Agent: We can start with a pilot');
    expect(file.text.match(/two hours/gi)).toHaveLength(1); // the echo is left out
    expect(await AuditLog.countDocuments({ action: 'meeting.transcript_downloaded' })).toBe(1);
    expect((await asOmar.get(`/api/meetings/${meetingId}/transcript/download`)).status).toBe(404);

    const audio = await asAsha.get(
      `/api/meetings/${meetingId}/transcript/segments/${transcript.lines[0].id}/audio`,
    );
    expect(audio.body.data.link).toContain('X-Amz-Signature');
  });

  it('a part is corrected by the recorder; the model’s words are kept and the change audited', async () => {
    await recordedMeeting();
    const [first] = (await asAsha.get(`/api/meetings/${meetingId}/transcript`)).body.data.lines;
    const fixed = await asAsha
      .patch(`/api/meetings/${meetingId}/transcript/segments/${first.id}`)
      .send({ text: 'We lose about two hours a day on press 2 because of breakdowns.' });
    expect(fixed.status).toBe(200);
    const row = await MeetingTranscriptSegment.findById(first.id).lean();
    expect(row.originalText).toContain('press two');
    expect(row.text).toContain('press 2');
    expect(await AuditLog.countDocuments({ action: 'meeting.transcript_corrected' })).toBe(1);
    expect(
      (
        await asOmar
          .patch(`/api/meetings/${meetingId}/transcript/segments/${first.id}`)
          .send({ text: 'x' })
      ).status,
    ).toBe(404);
  });

  it('the AI summary is made from the transcript, without the echo', async () => {
    await recordedMeeting();
    chatAnswers = [
      {
        summary: 'The customer loses two hours a day on press 2. We offered a sensor pilot.',
        clientProblems: ['Breakdowns on press 2'],
        machinesDiscussed: ['Press 2'],
        technicalRequirements: ['Vibration sensors'],
        budget: '',
        decisionMakers: [],
        competitors: [],
        commitments: ['We: start a pilot in two weeks'],
        nextSteps: ['Plan the pilot'],
        risks: [],
        missingInformation: ['Budget'],
        proposedTasks: [{ title: 'Send the pilot plan', dueInDays: 2 }],
      },
    ];
    const made = await asAsha.post(`/api/meetings/${meetingId}/summary`).send({});
    expect(made.status).toBe(200);
    expect(made.body.data.sourceType).toBe('transcript');
    const sent = JSON.parse(chatRequests.at(-1).user);
    expect(sent.isTranscript).toBe(true);
    expect(sent.notes).toContain('Others in the meeting: We lose about two hours');
    expect(sent.notes.match(/two hours/gi)).toHaveLength(1);
    expect(chatRequests.at(-1).system).toContain('OUR sales person');
    // Asking from the notes when there are none says so.
    expect(
      (await asAsha.post(`/api/meetings/${meetingId}/summary`).send({ source: 'notes' })).status,
    ).toBe(400);
  });

  it('an analysis made elsewhere is pasted, shown, and removed by who added it', async () => {
    const text = 'ChatGPT says: the customer wants a pilot on press 2 and fears downtime.';
    const added = await asCeo
      .post(`/api/meetings/${meetingId}/analyses`)
      .send({ label: 'ChatGPT', text });
    expect(added.status).toBe(201);
    expect(
      (await asOmar.post(`/api/meetings/${meetingId}/analyses`).send({ label: 'x', text })).status,
    ).toBe(404);
    const record = (await asAsha.get(`/api/meetings/${meetingId}/record`)).body.data;
    expect(record.externalAnalyses).toEqual([
      expect.objectContaining({
        label: 'ChatGPT',
        text,
        addedBy: expect.objectContaining({ name: 'Kunal CEO' }),
      }),
    ]);
    // Asha organises the meeting: she may remove it too.
    expect(record.externalAnalyses[0].canDelete).toBe(true);
    expect(
      (await asAsha.delete(`/api/meetings/${meetingId}/analyses/${added.body.data.id}`)).status,
    ).toBe(200);
    expect(
      (await asAsha.get(`/api/meetings/${meetingId}/record`)).body.data.externalAnalyses,
    ).toEqual([]);
  });

  it('deleting the meeting removes its recordings, text and audio', async () => {
    await recordedMeeting();
    expect(stored.size).toBe(3);
    expect((await asAsha.delete(`/api/meetings/${meetingId}`)).status).toBe(200);
    expect(await MeetingTranscriptSegment.countDocuments()).toBe(0);
    expect(await MeetingRecording.countDocuments()).toBe(0);
    expect(stored.size).toBe(0);
  });

  it('audio older than 60 days is removed; the text stays', async () => {
    await recordedMeeting();
    const removed = await service.runTranscriptAudioCleanup(new Date(Date.now() + 61 * 24 * HOUR));
    expect(removed.removed).toBe(3);
    expect(stored.size).toBe(0);
    const lines = (await asAsha.get(`/api/meetings/${meetingId}/transcript`)).body.data.lines;
    expect(lines.every((line) => !line.hasAudio && line.text)).toBe(true);
  });
});

describe('echo and helpers', () => {
  it('finds echoes only for overlapping, mostly equal mic lines', () => {
    const lines = [
      { track: 'tab', startMs: 0, endMs: 4000, text: 'Can you give predictive maintenance for us' },
      {
        track: 'mic',
        startMs: 200,
        endMs: 4200,
        text: 'can you give predictive maintenance for us',
      },
      {
        track: 'mic',
        startMs: 9000,
        endMs: 12000,
        text: 'Can you give predictive maintenance for us',
      },
      { track: 'mic', startMs: 300, endMs: 3000, text: 'Yes we can do that next week' },
    ];
    expect(service.findEchoes(lines)).toEqual([false, true, false, false]);
    expect(service.meetCodeOf('https://meet.google.com/abc-defg-hij?authuser=1')).toBe(
      'abc-defg-hij',
    );
    expect(service.meetCodeOf('hello')).toBeNull();
    expect(service.wavDurationMs(wav(1500))).toBe(1500);
    expect(() => service.wavDurationMs(Buffer.from('nope'))).toThrow();
  });
});
