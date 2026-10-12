import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// The key exists only for this test file; `fetch` is replaced, so no request leaves the
// computer: a chat call answers `reply`, an audio call answers `heard`. Storage is a Map.
process.env.OPENROUTER_API_KEY = 'test-openrouter-key';

const sent = [];
let reply = 'The owner has not been met yet.';
let heard = 'Namaste. Humein pehle ek furnace par pilot chahiye.';
vi.stubGlobal('fetch', async (url, options) => {
  const body = JSON.parse(options.body);
  sent.push({ url: String(url), body });
  const answer = String(url).endsWith('/audio/transcriptions')
    ? { text: heard, usage: { seconds: 42, cost: 0.003 } }
    : {
        model: body.models[0],
        choices: [{ message: { content: reply } }],
        usage: { prompt_tokens: 900, completion_tokens: 60, cost: 0.001 },
      };
  return new Response(JSON.stringify(answer), { status: 200 });
});

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

const { splitAudio } = await import('../ai/runChat.js');
const { createApp } = await import('../app.js');
const { createSessionMiddleware } = await import('../middleware/session.js');
const { AiRun } = await import('../models/aiRun.model.js');
const { AuditLog } = await import('../models/auditLog.model.js');
const { Call } = await import('../models/call.model.js');
const { CallTranscript } = await import('../models/callTranscript.model.js');
const { Role } = await import('../models/role.model.js');
const { User } = await import('../models/user.model.js');
const { runSeed, seedStartingLists, seedStatusLists } = await import('../seeds/seed.js');
const { clearTestDb, startTestDbWithTransactions, stopTestDb } =
  await import('./helpers/testDb.js');

const PASSWORD = 'correct-horse-battery';
let app;
let agent;
let asCeo;
let asAgent;
let asOther;
let accountId;
let contactId;
let leadId;
let callId;

async function signedInAs(user) {
  const client = request.agent(app);
  const response = await client
    .post('/api/auth/login')
    .send({ email: user.email, password: PASSWORD });
  expect(response.status).toBe(200);
  return client;
}
const ask = (client, body) => client.post('/api/ai/chat').send(body);
const question = (content, extra = {}) => ({ messages: [{ role: 'user', content }], ...extra });
const chatCalls = () => sent.filter((item) => item.url.endsWith('/chat/completions'));
const audioCalls = () => sent.filter((item) => item.url.endsWith('/audio/transcriptions'));

beforeAll(async () => {
  await startTestDbWithTransactions(); // creating a lead uses a transaction
  app = createApp({ sessionMiddleware: createSessionMiddleware() });
});
afterAll(stopTestDb);

beforeEach(async () => {
  await clearTestDb();
  sent.length = 0;
  stored.clear();
  reply = 'The owner has not been met yet.';
  await runSeed({ productName: 'P', companyName: 'C', workspaceDomain: 'engenx.in' });
  await seedStatusLists();
  await seedStartingLists();
  const roles = Object.fromEntries((await Role.find()).map((role) => [role.name, role]));
  const makeUser = (email, name, roleName) =>
    User.create({ email, name, roleId: roles[roleName]._id, status: 'active', password: PASSWORD });
  const ceo = await makeUser('ceo@engenx.in', 'Kunal CEO', 'CEO');
  agent = await makeUser('agent@engenx.in', 'Asha Agent', 'Sales Agent');
  const other = await makeUser('other@engenx.in', 'Omar Agent', 'Sales Agent');
  [asCeo, asAgent, asOther] = await Promise.all([ceo, agent, other].map(signedInAs));

  const created = await asAgent.post('/api/accounts/quick-add').send({
    account: { name: 'Shakti Castings', industry: 'Iron foundry', gstin: '27AAPFU0939F1ZV' },
    contacts: [{ name: 'Rajesh Patil', designation: 'Plant Head', phone_number: '91234 56780' }],
    lead: { name: 'Furnace energy monitoring', requirement: 'Track power use of 3 furnaces' },
  });
  accountId = created.body.data.account.id;
  contactId = created.body.data.contacts[0].id;
  leadId = created.body.data.lead.id;

  // A finished, recorded call of the agent with that person.
  const call = await Call.create({
    direction: 'outbound',
    fromNumber: '+918035000000',
    toNumber: '+919123456780',
    status: 'completed',
    startedAt: new Date(),
    endedAt: new Date(),
    durationSec: 42,
    userId: agent._id,
    contactId,
    accountId,
    opportunityId: leadId,
    recordingUrl: `${BUCKET_URL}recordings/call-1.mp3`,
  });
  callId = String(call._id);
  stored.set('recordings/call-1.mp3', Buffer.from('mp3-bytes'));
  await AuditLog.deleteMany({});
});

describe('the AI assistant', () => {
  it('answers about a record the person attached, from that record, and keeps nothing', async () => {
    const response = await ask(
      asAgent,
      question('What is still open on this lead?', {
        instruction: 'Answer in three short points.',
        context: [{ type: 'lead', id: leadId }],
      }),
    );
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      reply: 'The owner has not been met yet.',
      model: 'anthropic/claude-haiku-5.5',
      records: [{ type: 'lead', id: leadId, title: 'Lead "Furnace energy monitoring"' }],
    });

    // What the model was given: the rules, who asks, the instruction, the record, the question.
    const { messages } = chatCalls()[0].body;
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('Always answer in plain, simple, correct English');
    expect(messages[0].content).toContain('Asha Agent');
    expect(messages[0].content).toContain('Answer in three short points.');
    expect(messages[0].content).toContain('Furnace energy monitoring');
    expect(messages[0].content).toContain('Rajesh Patil');
    expect(messages[0].content).not.toContain('27AAPFU0939F1ZV');
    expect(messages[0].content).not.toContain('9123456780');
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'What is still open on this lead?' });
    expect(chatCalls()[0].body.provider).toEqual({ data_collection: 'deny' });

    // In our database: one line about the run, without the question or the answer.
    const run = await AiRun.findOne().lean();
    expect(run).toMatchObject({ task: 'chat', status: 'success', costPaise: 9 });
    expect(run.output).toBeUndefined();
    expect(String(run.userId)).toBe(String(agent._id));
    expect(JSON.stringify(run)).not.toContain('still open');
    expect(JSON.stringify(run)).not.toContain('owner has not been met');
  });

  it('carries the conversation and its files, and works without a record', async () => {
    const response = await ask(asAgent, {
      messages: [
        {
          role: 'user',
          content: 'Summarise this file.',
          attachments: [{ name: 'notes.txt', text: 'Pilot on furnace 2. PAN AAPFU0939F.' }],
        },
        { role: 'assistant', content: 'It is about a pilot on furnace 2.' },
        { role: 'user', content: 'Who decides?' },
      ],
    });
    expect(response.status).toBe(200);
    const { messages } = chatCalls()[0].body;
    expect(messages[0].content).toContain('No CRM record is attached');
    expect(messages[1].content).toContain('[Attached file: notes.txt]');
    expect(messages[1].content).toContain('Pilot on furnace 2.');
    expect(messages[1].content).not.toContain('AAPFU0939F'); // redacted in files too
    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
  });

  it('never shows a record the person may not see, and refuses a turn that is not theirs', async () => {
    for (const context of [
      [{ type: 'lead', id: leadId }],
      [{ type: 'account', id: accountId }],
      [{ type: 'contact', id: contactId }],
      [{ type: 'call', id: callId }],
    ]) {
      expect((await ask(asOther, question('Tell me about it', { context }))).status).toBe(404);
    }
    expect(chatCalls()).toHaveLength(0);
    // The CEO may see all of them.
    const all = await ask(
      asCeo,
      question('Give me the picture', {
        context: [
          { type: 'lead', id: leadId },
          { type: 'account', id: accountId },
          { type: 'contact', id: contactId },
          { type: 'call', id: callId },
        ],
      }),
    );
    expect(all.body.data.records.map((record) => record.title)).toEqual([
      'Lead "Furnace energy monitoring"',
      'Company "Shakti Castings"',
      'Person "Rajesh Patil"',
      'Phone call to Rajesh Patil',
    ]);

    const last = { role: 'assistant', content: 'Hello' };
    expect((await ask(asAgent, { messages: [last] })).status).toBe(400);
    expect((await ask(asAgent, { messages: [] })).status).toBe(400);
    expect((await ask(asAgent, question('  '))).status).toBe(400);
    expect((await request(app).post('/api/ai/chat').send(question('Hi'))).status).toBe(401);
  });
});

describe('the text of a call', () => {
  const transcript = (client) => client.get(`/api/calls/${callId}/transcript`);
  const make = (client) => client.post(`/api/calls/${callId}/transcript`);

  it('is made only when asked, kept with the call, and read by the manager line too', async () => {
    expect((await transcript(asAgent)).body.data).toEqual({
      isAiReady: true,
      hasRecording: true,
      transcript: null,
    });
    expect(audioCalls()).toHaveLength(0); // nothing by itself

    const made = await make(asAgent);
    expect(made.status).toBe(200);
    expect(made.body.data.transcript).toMatchObject({
      text: 'Namaste. Humein pehle ek furnace par pilot chahiye.',
      model: 'openai/gpt-transcribe',
      seconds: 42,
      generatedBy: 'Asha Agent',
    });
    // The recording went to the audio-to-text model, as mp3.
    expect(audioCalls()[0].body).toMatchObject({
      model: 'openai/gpt-transcribe',
      input_audio: { format: 'mp3', data: Buffer.from('mp3-bytes').toString('base64') },
    });
    expect(await AuditLog.countDocuments({ action: 'call.transcript_made' })).toBe(1);
    // The run is written down without the text.
    const run = await AiRun.findOne({ task: 'transcribeAudio' }).lean();
    expect(run).toMatchObject({ status: 'success', entityType: 'calls' });
    expect(run.output).toBeUndefined();

    // The CEO reads the same text without a new model call; another agent does not exist here.
    expect((await transcript(asCeo)).body.data.transcript.text).toContain('pilot chahiye');
    expect(audioCalls()).toHaveLength(1);
    expect((await transcript(asOther)).status).toBe(404);
    expect((await make(asOther)).status).toBe(404);
    const listed = (await asAgent.get(`/api/calls?opportunityId=${leadId}`)).body.data[0];
    expect(listed).toMatchObject({ hasRecording: true, hasTranscript: true });

    // Made again (by the CEO): it replaces the first one.
    heard = 'Hello. We want a pilot on one furnace first.';
    const again = await make(asCeo);
    expect(again.body.data.transcript).toMatchObject({
      text: 'Hello. We want a pilot on one furnace first.',
      generatedBy: 'Kunal CEO',
    });
    expect(await CallTranscript.countDocuments()).toBe(1);

    // The assistant gets the text when the call is attached.
    await ask(
      asAgent,
      question('Summarise this call', { context: [{ type: 'call', id: callId }] }),
    );
    expect(chatCalls()[0].body.messages[0].content).toContain(
      'We want a pilot on one furnace first.',
    );
    heard = 'Namaste. Humein pehle ek furnace par pilot chahiye.';
  });

  it('needs a recording', async () => {
    await Call.updateOne({ _id: callId }, { $unset: { recordingUrl: '' } });
    expect((await make(asAgent)).status).toBe(409);
    expect((await transcript(asAgent)).body.data.hasRecording).toBe(false);
    expect(audioCalls()).toHaveLength(0);
  });
});

describe('files in the assistant', () => {
  const add = (client, buffer, name, type) =>
    client.post('/api/ai/chat/files').attach('file', buffer, { filename: name, contentType: type });

  it('turns a file into text without storing it: text as it is, audio heard, a PDF read', async () => {
    const text = await add(asAgent, Buffer.from('Line 1\nLine 2'), 'notes.txt', 'text/plain');
    expect(text.body.data).toEqual({ name: 'notes.txt', kind: 'text', text: 'Line 1\nLine 2' });
    expect(sent).toHaveLength(0); // no model needed

    const audio = await add(asAgent, Buffer.from('wav-bytes'), 'voice note.wav', 'audio/wav');
    expect(audio.body.data).toMatchObject({ kind: 'audio', text: heard });
    expect(audioCalls()[0].body.input_audio.format).toBe('wav');

    reply = 'QUOTATION\nItem: Energy meter, Qty 3';
    const pdf = await add(asAgent, Buffer.from('%PDF-1.4 …'), 'quote.pdf', 'application/pdf');
    expect(pdf.body.data).toEqual({ name: 'quote.pdf', kind: 'document', text: reply });
    const part = chatCalls()[0].body.messages[1].content[1];
    expect(part.type).toBe('file');
    expect(part.file.file_data.startsWith('data:application/pdf;base64,')).toBe(true);

    expect((await add(asAgent, Buffer.from('PK'), 'archive.zip', 'application/zip')).status).toBe(
      400,
    );
    expect(stored.size).toBe(1); // only the call recording of the set-up: no file was kept
    expect(await AiRun.countDocuments({ task: { $in: ['transcribeAudio', 'readFile'] } })).toBe(2);
  });

  it('a long MP3 is cut at frame starts; another format has to fit in one piece', () => {
    const frame = Buffer.concat([Buffer.from([0xff, 0xfb]), Buffer.alloc(98, 1)]);
    const mp3 = Buffer.concat(Array.from({ length: 50 }, () => frame)); // 5000 bytes
    const pieces = splitAudio(mp3, 'mp3', 1024);
    expect(pieces.length).toBeGreaterThan(3);
    expect(Buffer.concat(pieces).equals(mp3)).toBe(true);
    expect(pieces.every((piece) => piece[0] === 0xff && piece[1] === 0xfb)).toBe(true);
    expect(splitAudio(mp3, 'mp3', 10_000)).toHaveLength(1);
    expect(() => splitAudio(mp3, 'wav', 1024)).toThrow(/too large/);
  });
});
