import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// The key exists only for this test file; `fetch` is replaced, so no request leaves the
// computer. File storage is a Map.
process.env.OPENROUTER_API_KEY = 'test-openrouter-key';

const sent = [];
let answer = null;
vi.stubGlobal('fetch', async (url, options) => {
  sent.push(JSON.parse(options.body));
  return new Response(
    JSON.stringify({
      model: sent.at(-1).models[0],
      choices: [{ message: { content: JSON.stringify(answer) } }],
      usage: { prompt_tokens: 300, completion_tokens: 80, cost: 0.0002 },
    }),
    { status: 200 },
  );
});

const stored = new Map();
vi.mock('../infra/storage.js', () => ({
  isStorageConfigured: () => true,
  objectUrl: (key) => `memory://${key}`,
  keyFromUrl: () => null,
  uploadObject: async ({ key, body }) => {
    stored.set(key, Buffer.from(body));
    return `memory://${key}`;
  },
  readObject: async (key) => stored.get(key) ?? null,
  deleteObject: async (key) => {
    stored.delete(key);
  },
  toReadableUrl: async (url) => url ?? null,
}));

const { maskSample } = await import('../ai/tasks/suggestCsvMapping.js');
const { createApp } = await import('../app.js');
const { createSessionMiddleware } = await import('../middleware/session.js');
const { AiRun } = await import('../models/aiRun.model.js');
const { Import } = await import('../models/import.model.js');
const { Role } = await import('../models/role.model.js');
const { User } = await import('../models/user.model.js');
const { runSeed, seedStatusLists } = await import('../seeds/seed.js');
const { clearTestDb, startTestDb, stopTestDb } = await import('./helpers/testDb.js');

const PASSWORD = 'correct-horse-battery';
// Headings the built-in guess does not know.
const FILE = [
  'Firma,Branche,Ansprechpartner,Mobil,Mail,Bemerkung',
  'Bharat Forge,Forgings,Asha Verma,98765 43210,asha.verma@bharatforge.example,Met at the expo',
  'Thermax,Boilers,Rajesh Sen,91234 56780,rajesh@thermax.example,',
  '',
].join('\r\n');
let app;
let asCeo;
let asAgent;

async function signedInAs(user) {
  const client = request.agent(app);
  const response = await client
    .post('/api/auth/login')
    .send({ email: user.email, password: PASSWORD });
  expect(response.status).toBe(200);
  return client;
}

beforeAll(async () => {
  await startTestDb();
  app = createApp({ sessionMiddleware: createSessionMiddleware() });
});
afterAll(stopTestDb);
beforeEach(async () => {
  await clearTestDb();
  stored.clear();
  sent.length = 0;
  await runSeed({ productName: 'P', companyName: 'C', workspaceDomain: 'engenx.in' });
  await seedStatusLists();
  const roles = Object.fromEntries((await Role.find()).map((role) => [role.name, role]));
  const makeUser = (email, roleName) =>
    User.create({
      email,
      name: email,
      roleId: roles[roleName]._id,
      status: 'active',
      password: PASSWORD,
    });
  asCeo = await signedInAs(await makeUser('ceo@engenx.in', 'CEO'));
  asAgent = await signedInAs(await makeUser('agent@engenx.in', 'Sales Agent'));
});

describe('CSV import: suggest the columns with AI', () => {
  it('suggests a field per column from headings and masked samples, and saves nothing', async () => {
    const uploaded = (
      await asCeo.post('/api/imports').attach('file', Buffer.from(FILE, 'utf8'), 'kunden.csv')
    ).body.data;
    const before = (await Import.findById(uploaded.id).lean()).mapping;

    answer = {
      mapping: [
        { column: 'Firma', field: 'name' },
        { column: 'Branche', field: 'industry' },
        { column: 'Ansprechpartner', field: 'contact.name' },
        { column: 'Mobil', field: 'contact.phone_number' },
        { column: 'Mail', field: 'contact.email' },
        { column: 'Bemerkung', field: null },
        // Things the model must not get away with:
        { column: 'Mail', field: 'email' }, // the same column twice
        { column: 'Branche', field: 'name' }, // a field that is taken
        { column: 'Not a column', field: 'website' },
        { column: 'Bemerkung', field: 'made.up.field' },
      ],
    };
    const suggested = await asCeo.post(`/api/imports/${uploaded.id}/suggest-mapping`);
    expect(suggested.status).toBe(200);
    expect(suggested.body.data.mapping).toEqual([
      { column: 'Firma', field: 'name' },
      { column: 'Branche', field: 'industry' },
      { column: 'Ansprechpartner', field: 'contact.name' },
      { column: 'Mobil', field: 'contact.phone_number' },
      { column: 'Mail', field: 'contact.email' },
    ]);

    // What the model saw: the headings, and samples without real digits or email names.
    const shown = JSON.parse(sent[0].messages[1].content);
    expect(shown.columns.map((column) => column.heading)).toEqual(uploaded.headers);
    expect(shown.columns[3].samples).toEqual(['99999 99999', '99999 99999']);
    expect(shown.columns[4].samples[0]).toBe('xxxxxx@bharatforge.example');
    expect(shown.fields.some((field) => field.key === 'contact.phone_number')).toBe(true);
    expect(sent[0].messages[1].content).not.toContain('98765');
    // The cheap class of model, and a record of the run.
    expect(sent[0].models[0]).toBe('anthropic/claude-haiku-5.5');
    expect(await AiRun.findOne().lean()).toMatchObject({
      task: 'suggestCsvMapping',
      status: 'success',
    });
    // Nothing was saved: the mapping of the import is as it was.
    expect((await Import.findById(uploaded.id).lean()).mapping).toEqual(before);
  });

  it('is for people who may import, and only for an import they may see', async () => {
    const uploaded = (
      await asCeo.post('/api/imports').attach('file', Buffer.from(FILE, 'utf8'), 'kunden.csv')
    ).body.data;
    expect((await asAgent.post(`/api/imports/${uploaded.id}/suggest-mapping`)).status).toBe(403);
    expect((await asCeo.post('/api/imports/0123456789abcdef01234567/suggest-mapping')).status).toBe(
      404,
    );
    expect((await request(app).post(`/api/imports/${uploaded.id}/suggest-mapping`)).status).toBe(
      401,
    );
    expect(sent).toHaveLength(0);
  });

  it('masks a sample: digits and the name of an email, keeping the shape', () => {
    expect(maskSample('+91 98765-43210')).toBe('+99 99999-99999');
    expect(maskSample('asha.verma@bharatforge.example')).toBe('xxxxxx@bharatforge.example');
    expect(maskSample('Plot 12, MIDC Phase 2')).toBe('Plot 99, MIDC Phase 9');
    expect(maskSample(null)).toBe('');
  });
});
