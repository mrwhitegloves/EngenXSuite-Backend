import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// S3 is the one thing replaced in this file: nothing is uploaded anywhere. The fake keeps the
// "files" in memory and signs links the same way the real module's callers expect.
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
  toReadableUrl: async (url) => {
    if (!url) return null;
    return url.startsWith(BUCKET_URL) ? `${url}?X-Amz-Signature=test` : url;
  },
}));

const { createApp } = await import('../app.js');
const { createSessionMiddleware } = await import('../middleware/session.js');
const { AuditLog } = await import('../models/auditLog.model.js');
const { Role } = await import('../models/role.model.js');
const { User } = await import('../models/user.model.js');
const { runSeed } = await import('../seeds/seed.js');
const { importGooglePicture } = await import('../services/avatar.service.js');
const { clearTestDb, startTestDb, stopTestDb } = await import('./helpers/testDb.js');

const PASSWORD = 'correct-horse-battery';
// The smallest things that start like real images.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4),
  Buffer.from('WEBP'),
  Buffer.alloc(32),
]);
const NOT_AN_IMAGE = Buffer.from('<script>alert(1)</script>');

let app;
let roles;
let ceo;
let manager;
let agent;
let otherAgent;

const makeUser = (email, roleName, extra = {}) =>
  User.create({
    email,
    name: email,
    roleId: roles[roleName]._id,
    status: 'active',
    password: PASSWORD,
    ...extra,
  });

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
  roles = Object.fromEntries((await Role.find()).map((role) => [role.name, role]));
  ceo = await makeUser('ceo@engenx.in', 'CEO');
  manager = await makeUser('manager@engenx.in', 'Sales Manager');
  agent = await makeUser('agent@engenx.in', 'Sales Agent', { managerId: manager._id });
  otherAgent = await makeUser('other@engenx.in', 'Sales Agent');
});

describe('a user changes their own profile picture', () => {
  it('uploads the image to storage and saves only its S3 address on the user', async () => {
    const client = await signedInAs(agent);
    const response = await client.post('/api/auth/me/avatar').attach('file', PNG, 'me.png');
    expect(response.status).toBe(200);

    const saved = (await User.findById(agent._id).lean()).avatarUrl;
    expect(saved).toMatch(new RegExp(`^${BUCKET_URL}avatars/${agent._id}/[0-9a-f]{24}\\.png$`));
    expect(stored.size).toBe(1);
    expect([...stored.values()][0].contentType).toBe('image/png');

    // The browser receives a link it can open (signed), not the bare private address.
    expect(response.body.data.avatarUrl).toBe(`${saved}?X-Amz-Signature=test`);
    expect((await client.get('/api/auth/me')).body.data.avatarUrl).toContain('X-Amz-Signature');
  });

  it('accepts PNG, JPG and WebP by their real content', async () => {
    const client = await signedInAs(agent);
    for (const [buffer, extension] of [
      [PNG, 'png'],
      [JPG, 'jpg'],
      [WEBP, 'webp'],
    ]) {
      const response = await client.post('/api/auth/me/avatar').attach('file', buffer, 'x.bin');
      expect(response.status).toBe(200);
      expect((await User.findById(agent._id).lean()).avatarUrl).toMatch(
        new RegExp(`\\.${extension}$`),
      );
    }
  });

  it('rejects a file that is not an image, whatever its name says', async () => {
    const client = await signedInAs(agent);
    const response = await client
      .post('/api/auth/me/avatar')
      .attach('file', NOT_AN_IMAGE, 'photo.png');
    expect(response.status).toBe(400);
    expect(stored.size).toBe(0);
    expect((await User.findById(agent._id).lean()).avatarUrl).toBeUndefined();
  });

  it('rejects a file over 2 MB and a request without a file', async () => {
    const client = await signedInAs(agent);
    const tooBig = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    expect(
      (await client.post('/api/auth/me/avatar').attach('file', tooBig, 'big.png')).status,
    ).toBe(400);
    expect((await client.post('/api/auth/me/avatar')).status).toBe(400);
    expect(stored.size).toBe(0);
  });

  it('a new picture replaces the old one in storage; removing it deletes it', async () => {
    const client = await signedInAs(agent);
    await client.post('/api/auth/me/avatar').attach('file', PNG, 'a.png');
    const firstKey = [...stored.keys()][0];
    await client.post('/api/auth/me/avatar').attach('file', JPG, 'b.jpg');
    expect(stored.size).toBe(1);
    expect(stored.has(firstKey)).toBe(false);

    const removed = await client.delete('/api/auth/me/avatar');
    expect(removed.body.data.avatarUrl).toBeNull();
    expect(stored.size).toBe(0);
    expect((await User.findById(agent._id).lean()).avatarUrl).toBeUndefined();
  });

  it('needs a signed-in user', async () => {
    expect(
      (await request(app).post('/api/auth/me/avatar').attach('file', PNG, 'a.png')).status,
    ).toBe(401);
  });
});

describe('the CEO or a manager changes the picture of a user', () => {
  it('the CEO can for anyone; a manager only for their own team', async () => {
    const ceoClient = await signedInAs(ceo);
    const forOther = await ceoClient
      .post(`/api/users/${otherAgent._id}/avatar`)
      .attach('file', PNG, 'a.png');
    expect(forOther.status).toBe(200);
    expect(forOther.body.data.avatarUrl).toContain('X-Amz-Signature');

    const managerClient = await signedInAs(manager);
    expect(
      (await managerClient.post(`/api/users/${agent._id}/avatar`).attach('file', PNG, 'a.png'))
        .status,
    ).toBe(200);
    expect(
      (await managerClient.post(`/api/users/${otherAgent._id}/avatar`).attach('file', PNG, 'a.png'))
        .status,
    ).toBe(404);
    expect((await managerClient.delete(`/api/users/${otherAgent._id}/avatar`)).status).toBe(404);
  });

  it("a Sales Agent cannot change anyone else's picture", async () => {
    const client = await signedInAs(agent);
    expect(
      (await client.post(`/api/users/${otherAgent._id}/avatar`).attach('file', PNG, 'a.png'))
        .status,
    ).toBe(403);
    expect(stored.size).toBe(0);
  });

  it('the users list returns openable links, and a picture from elsewhere is left as it is', async () => {
    const ceoClient = await signedInAs(ceo);
    await ceoClient.post(`/api/users/${agent._id}/avatar`).attach('file', PNG, 'a.png');
    await User.updateOne(
      { _id: otherAgent._id },
      { $set: { avatarUrl: 'https://lh3.googleusercontent.com/x' } },
    );

    const list = await ceoClient.get('/api/users');
    const byEmail = Object.fromEntries(list.body.data.map((user) => [user.email, user.avatarUrl]));
    expect(byEmail['agent@engenx.in']).toContain('X-Amz-Signature');
    expect(byEmail['other@engenx.in']).toBe('https://lh3.googleusercontent.com/x');
    expect(byEmail['ceo@engenx.in']).toBeNull();
  });

  it('writes an audit entry', async () => {
    await (
      await signedInAs(ceo)
    )
      .post(`/api/users/${agent._id}/avatar`)
      .attach('file', PNG, 'a.png');
    const entries = await AuditLog.find({ action: 'user.avatar_changed' }).lean();
    expect(entries).toHaveLength(1);
    expect(String(entries[0].userId)).toBe(String(ceo._id));
  });
});

describe('copying a Google profile picture into our storage', () => {
  const GOOGLE_URL = 'https://lh3.googleusercontent.com/a-/ALV-abc123=s96-c';
  const fetchReturning = (body, ok = true) =>
    vi.fn(async () => ({ ok, arrayBuffer: async () => body }));

  afterEach(() => vi.unstubAllGlobals());

  it('saves the picture in storage and replaces the Google link with the S3 address', async () => {
    await User.updateOne({ _id: agent._id }, { $set: { avatarUrl: GOOGLE_URL } });
    const fetchMock = fetchReturning(PNG);
    vi.stubGlobal('fetch', fetchMock);

    expect(await importGooglePicture({ userId: agent._id, url: GOOGLE_URL })).toBe(true);
    // A larger picture than Google's default 96 pixels is asked for.
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://lh3.googleusercontent.com/a-/ALV-abc123=s256-c',
    );
    expect((await User.findById(agent._id).lean()).avatarUrl).toMatch(
      new RegExp(`^${BUCKET_URL}avatars/${agent._id}/`),
    );
    expect(stored.size).toBe(1);
  });

  it('refuses any address that is not a Google picture host over https', async () => {
    const fetchMock = fetchReturning(PNG);
    vi.stubGlobal('fetch', fetchMock);
    const refused = [
      'http://lh3.googleusercontent.com/a/x',
      'https://evil.example.com/lh3.googleusercontent.com/x',
      'https://googleusercontent.com.evil.example/x',
      'http://169.254.169.254/latest/meta-data/',
      'file:///etc/passwd',
      'not a url',
    ];
    for (const url of refused) {
      expect(await importGooglePicture({ userId: agent._id, url })).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stored.size).toBe(0);
  });

  it('keeps what the user had when Google answers with an error or with something that is not an image', async () => {
    await User.updateOne({ _id: agent._id }, { $set: { avatarUrl: GOOGLE_URL } });

    vi.stubGlobal('fetch', fetchReturning(PNG, false));
    expect(await importGooglePicture({ userId: agent._id, url: GOOGLE_URL })).toBe(false);

    vi.stubGlobal('fetch', fetchReturning(NOT_AN_IMAGE));
    expect(await importGooglePicture({ userId: agent._id, url: GOOGLE_URL })).toBe(false);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    expect(await importGooglePicture({ userId: agent._id, url: GOOGLE_URL })).toBe(false);

    expect((await User.findById(agent._id).lean()).avatarUrl).toBe(GOOGLE_URL);
    expect(stored.size).toBe(0);
  });
});
