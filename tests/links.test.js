import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// The Links screen (/api/links). S3 is replaced by an in-memory fake; credential values are
// sealed with a test key.
Object.assign(process.env, { ENCRYPTION_KEY: randomBytes(32).toString('base64') });

const BUCKET_URL = 'https://test-bucket.s3.ap-south-1.amazonaws.com/';
const stored = new Map();
vi.mock('../infra/storage.js', () => ({
  isStorageConfigured: () => true,
  objectUrl: (key) => `${BUCKET_URL}${key}`,
  keyFromUrl: (url) => (url?.startsWith(BUCKET_URL) ? url.slice(BUCKET_URL.length) : null),
  uploadObject: async ({ key, body, contentType }) => {
    stored.set(key, { size: body.length, contentType });
    return `${BUCKET_URL}${key}`;
  },
  deleteObject: async (key) => {
    stored.delete(key);
  },
  toReadableUrl: async (url) => (url ? `${url}?X-Amz-Signature=test` : null),
}));

const { createApp } = await import('../app.js');
const { createSessionMiddleware } = await import('../middleware/session.js');
const { AuditLog } = await import('../models/auditLog.model.js');
const { Link } = await import('../models/link.model.js');
const { Role } = await import('../models/role.model.js');
const { User } = await import('../models/user.model.js');
const { runSeed } = await import('../seeds/seed.js');
const migration = await import('../migrations/20261030134407-add-links-feature.js');
const { clearTestDb, startTestDb, stopTestDb } = await import('./helpers/testDb.js');
const mongoose = (await import('mongoose')).default;

const PASSWORD = 'correct-horse-battery';
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
]);

let app;
let ceo;
let agent;

async function signedInAs(user) {
  const client = request.agent(app);
  await client.post('/api/auth/login').send({ email: user.email, password: PASSWORD });
  return client;
}

beforeAll(async () => {
  await startTestDb();
  app = createApp({ sessionMiddleware: createSessionMiddleware() });
});
afterAll(stopTestDb);

beforeEach(async () => {
  stored.clear();
  await clearTestDb();
  await runSeed({ productName: 'P', companyName: 'C', workspaceDomain: 'engenx.in' });
  const roles = Object.fromEntries((await Role.find()).map((role) => [role.name, role]));
  const make = (email, role) =>
    User.create({
      email,
      name: email,
      roleId: roles[role]._id,
      status: 'active',
      password: PASSWORD,
    });
  ceo = await make('ceo@engenx.in', 'CEO');
  agent = await make('agent@engenx.in', 'Sales Agent');
});

const LINK = {
  name: 'Google Ads',
  url: 'https://ads.google.com',
  description: 'Company ad account',
  credentials: [
    { key: 'Email ID', value: 'team@example.com' },
    { key: 'Password', value: 's3cret-pass' },
  ],
};

describe('links', () => {
  it('saves a link with sealed credential values and lists it', async () => {
    const client = await signedInAs(ceo);
    const created = await client.post('/api/links').send(LINK);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ name: 'Google Ads', credentials: LINK.credentials });

    const raw = await Link.findById(created.body.data.id).lean();
    expect(JSON.stringify(raw)).not.toContain('s3cret-pass');
    expect(raw.credentials[0].key).toBe('Email ID');

    const list = await client.get('/api/links?search=ads');
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].credentials[1].value).toBe('s3cret-pass');
    expect(list.body.meta.total).toBe(1);

    // The audit log names the credential keys, never their values.
    const audit = await AuditLog.find({ entityType: 'links' }).lean();
    expect(JSON.stringify(audit)).not.toContain('s3cret-pass');
  });

  it('edits, refuses addresses that are not web addresses, and deletes', async () => {
    const client = await signedInAs(ceo);
    const { body } = await client.post('/api/links').send(LINK);
    const id = body.data.id;
    const edited = await client
      .patch(`/api/links/${id}`)
      .send({ name: 'Google Ads (main)', credentials: [{ key: 'Email ID', value: 'a@b.in' }] });
    expect(edited.body.data).toMatchObject({
      name: 'Google Ads (main)',
      credentials: [{ key: 'Email ID', value: 'a@b.in' }],
    });
    const bad = await client.post('/api/links').send({ ...LINK, url: 'javascript:alert(1)' });
    expect(bad.status).toBe(400);
    expect((await client.delete(`/api/links/${id}`)).status).toBe(200);
    expect(await Link.countDocuments()).toBe(0);
  });

  it('uploads a thumbnail to storage and replaces the old one', async () => {
    const client = await signedInAs(ceo);
    const { body } = await client.post('/api/links').send(LINK);
    const first = await client
      .post(`/api/links/${body.data.id}/thumbnail`)
      .attach('file', PNG, 'x.png');
    expect(first.status).toBe(200);
    expect(first.body.data.thumbnailUrl).toContain('X-Amz-Signature');
    await client.post(`/api/links/${body.data.id}/thumbnail`).attach('file', PNG, 'y.png');
    expect(stored.size).toBe(1);
    const notImage = await client
      .post(`/api/links/${body.data.id}/thumbnail`)
      .attach('file', Buffer.from('<script>'), 'x.png');
    expect(notImage.status).toBe(400);
  });

  it('only roles with the links feature may see or change links', async () => {
    const client = await signedInAs(agent);
    expect((await client.get('/api/links')).status).toBe(403);
    expect((await client.post('/api/links').send(LINK)).status).toBe(403);
  });

  it('the migration gives the CEO role every action on links, and down takes it away', async () => {
    const roles = mongoose.connection.db.collection('roles');
    await roles.updateMany({}, { $pull: { grants: { feature: 'links' } } });
    await migration.up(mongoose.connection.db);
    await migration.up(mongoose.connection.db); // safe twice
    const ceoRole = await roles.findOne({ name: 'CEO' });
    expect(ceoRole.grants.filter((grant) => grant.feature === 'links')).toHaveLength(7);
    const agentRole = await roles.findOne({ name: 'Sales Agent' });
    expect(agentRole.grants.some((grant) => grant.feature === 'links')).toBe(false);
    await migration.down(mongoose.connection.db);
    expect((await roles.findOne({ name: 'CEO' })).grants.some((g) => g.feature === 'links')).toBe(
      false,
    );
  });
});
