import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// What is kept after a meeting: files, a voice note turned into text, the AI's summary and the
// tasks it proposes. The AI is replaced by prepared answers; file storage is a Map.
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

let aiAnswers = [];
let aiRequests = [];
let heard = '';
vi.stubGlobal('fetch', async (input, options = {}) => {
  const url = String(input);
  const json = (body) => new Response(JSON.stringify(body), { status: 200 });
  if (url.endsWith('/audio/transcriptions')) {
    return json({ text: heard, usage: { seconds: 30, cost: 0.002 } });
  }
  if (!url.includes('openrouter.ai')) return json({});
  const body = JSON.parse(options.body);
  aiRequests.push(JSON.parse(body.messages.at(-1).content));
  return json({
    model: body.models[0],
    choices: [{ message: { content: JSON.stringify(aiAnswers.shift()) } }],
    usage: { prompt_tokens: 300, completion_tokens: 200, cost: 0.002 },
  });
});

const { createApp } = await import('../app.js');
const { createSessionMiddleware } = await import('../middleware/session.js');
const { Meeting } = await import('../models/meeting.model.js');
const { Role } = await import('../models/role.model.js');
const { Task } = await import('../models/task.model.js');
const { User } = await import('../models/user.model.js');
const { runSeed, seedStartingLists, seedStatusLists } = await import('../seeds/seed.js');
const { clearTestDb, startTestDbWithTransactions, stopTestDb } =
  await import('./helpers/testDb.js');

const PASSWORD = 'correct-horse-battery';
const HOUR = 60 * 60 * 1000;
const NOTES =
  'Plant head wants a pilot on press 2. Budget about 8 lakh. We send the offer by Friday.';
const SUMMARY = {
  summary: 'The plant head wants a pilot on press 2.',
  clientProblems: ['Unplanned stops on press 2'],
  machinesDiscussed: ['Press 2'],
  technicalRequirements: [],
  budget: 'About 8 lakh was named.',
  decisionMakers: ['Plant head'],
  competitors: [],
  commitments: ['We: send the offer by Friday'],
  nextSteps: ['Send the offer'],
  risks: [],
  missingInformation: ['Who signs the order'],
  proposedTasks: [
    { title: 'Send the offer for the pilot', dueInDays: 3 },
    { title: 'Ask who signs the order', dueInDays: null },
  ],
};
let app;
let asAsha;
let asOmar;
let asCeo;
let meetingId;
let leadId;

async function signedInAs(user) {
  const client = request.agent(app);
  const response = await client
    .post('/api/auth/login')
    .send({ email: user.email, password: PASSWORD });
  expect(response.status).toBe(200);
  return client;
}
const recordOf = async (client) =>
  (await client.get(`/api/meetings/${meetingId}/record`)).body.data;

beforeAll(async () => {
  await startTestDbWithTransactions(); // creating a lead uses a transaction
  app = createApp({ sessionMiddleware: createSessionMiddleware() });
});
afterAll(stopTestDb);

beforeEach(async () => {
  await clearTestDb();
  stored.clear();
  aiAnswers = [];
  aiRequests = [];
  heard = '';
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
  [asAsha, asOmar, asCeo] = await Promise.all(users.map(signedInAs));
  const created = await asAsha.post('/api/accounts/quick-add').send({
    account: { name: 'Bharat Forge' },
    contacts: [{ name: 'Asha Verma', email: 'asha.verma@bharatforge.example' }],
    lead: { name: 'OEE for press line' },
  });
  leadId = created.body.data.lead.id;
  const meeting = await asAsha.post('/api/meetings').send({
    title: 'Pilot scope',
    mode: 'plant_visit',
    startAt: new Date(Date.now() - 3 * HOUR).toISOString(),
    endAt: new Date(Date.now() - 2 * HOUR).toISOString(),
    opportunityId: leadId,
  });
  meetingId = meeting.body.data.id;
});

describe('the summary of a meeting', () => {
  it('is made from the notes on request; its tasks exist only once accepted', async () => {
    expect((await asAsha.post(`/api/meetings/${meetingId}/summary`)).status).toBe(400); // no notes
    await asAsha
      .post(`/api/meetings/${meetingId}/close`)
      .send({ status: 'completed', notes: NOTES });
    expect((await recordOf(asAsha)).summary).toBeNull();

    aiAnswers = [SUMMARY];
    const made = await asAsha.post(`/api/meetings/${meetingId}/summary`);
    expect(made.status).toBe(200);
    expect(made.body.data).toMatchObject({
      summary: SUMMARY.summary,
      budget: 'About 8 lakh was named.',
      commitments: ['We: send the offer by Friday'],
      missingInformation: ['Who signs the order'],
    });
    expect(made.body.data.proposedTasks.map((task) => [task.title, task.status])).toEqual([
      ['Send the offer for the pilot', 'pending'],
      ['Ask who signs the order', 'pending'],
    ]);
    expect(made.body.data.proposedTasks[1].dueAt).toBeNull();
    expect(aiRequests[0]).toMatchObject({
      notes: NOTES,
      meeting: { title: 'Pilot scope', kind: 'plant_visit', company: 'Bharat Forge' },
    });
    expect(await Task.countDocuments({ title: /offer/ })).toBe(0); // nothing by itself

    const decide = (client, body) =>
      client.post(`/api/meetings/${meetingId}/summary/tasks`).send(body);
    const accepted = await decide(asAsha, { index: 0, decision: 'accept' });
    expect(accepted.body.data.proposedTasks[0]).toMatchObject({ status: 'accepted' });
    const task = await Task.findById(accepted.body.data.proposedTasks[0].taskId).lean();
    expect(task).toMatchObject({ title: 'Send the offer for the pilot', type: 'follow_up' });
    expect(String(task.opportunityId)).toBe(leadId);
    expect((await decide(asAsha, { index: 0, decision: 'accept' })).status).toBe(409);
    expect(
      (await decide(asAsha, { index: 1, decision: 'reject' })).body.data.proposedTasks[1].status,
    ).toBe('rejected');
    expect((await decide(asAsha, { index: 7, decision: 'accept' })).status).toBe(404);
    expect(await Task.countDocuments({ title: /offer|signs/ })).toBe(1);

    // Made again: the accepted task stays, the rest is new.
    aiAnswers = [{ ...SUMMARY, proposedTasks: [{ title: 'Book the pilot dates', dueInDays: 7 }] }];
    const again = await asAsha.post(`/api/meetings/${meetingId}/summary`);
    expect(again.body.data.proposedTasks.map((item) => [item.title, item.status])).toEqual([
      ['Send the offer for the pilot', 'accepted'],
      ['Book the pilot dates', 'pending'],
    ]);

    // The CEO reads it and may change it; another agent does not reach the meeting at all.
    expect((await recordOf(asCeo)).summary.permissions.canEdit).toBe(true);
    expect((await asOmar.get(`/api/meetings/${meetingId}/record`)).status).toBe(404);
    expect((await asOmar.post(`/api/meetings/${meetingId}/summary`)).status).toBe(404);
  });
});

describe('files of a meeting', () => {
  it('a picture is kept and opened by a signed link; a voice note becomes notes on request', async () => {
    const upload = (client, name, type, content) =>
      client
        .post(`/api/meetings/${meetingId}/files`)
        .attach('file', Buffer.from(content), { filename: name, contentType: type });
    const picture = await upload(asAsha, 'press 2.jpg', 'image/jpeg', 'jpeg-bytes');
    expect(picture.status).toBe(201);
    expect(picture.body.data).toMatchObject({ filename: 'press 2.jpg', isAudio: false });
    expect(picture.body.data.link).toContain('X-Amz-Signature');
    const voice = await upload(asAsha, 'after the visit.mp3', 'audio/mpeg', 'mp3-bytes');
    expect(voice.body.data.isAudio).toBe(true);
    expect((await upload(asOmar, 'x.jpg', 'image/jpeg', 'x')).status).toBe(404);
    expect((await recordOf(asAsha)).files.map((file) => file.filename)).toEqual([
      'press 2.jpg',
      'after the visit.mp3',
    ]);

    const transcribe = (url) =>
      asAsha.post(`/api/meetings/${meetingId}/files/transcribe`).send({ url });
    expect((await transcribe(picture.body.data.url)).status).toBe(400); // not audio
    heard = 'They want a pilot on press two.';
    const text = await transcribe(voice.body.data.url);
    expect(text.body.data.text).toBe('They want a pilot on press two.');
    expect((await Meeting.findById(meetingId).lean()).notes).toBe(
      '[Voice note: after the visit.mp3]\nThey want a pilot on press two.',
    );
    expect((await transcribe(`${BUCKET_URL}backups/x.gz`)).status).toBe(404);
  });
});
