import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';

// Storage is replaced by a Map in memory, and the job queue by a list. The database is the real
// in-memory MongoDB, so backup and restore run against real collections, types and indexes.
const state = { objects: new Map(), configured: true, enqueued: [], redisUp: true };

vi.mock('../infra/storage.js', () => ({
  isStorageConfigured: () => state.configured,
  uploadObject: async ({ key, body }) => {
    state.objects.set(key, Buffer.from(body));
    return `memory://${key}`;
  },
  readObject: async (key) => state.objects.get(key) ?? null,
  deleteObject: async (key) => {
    state.objects.delete(key);
  },
  toReadableUrl: async (url) => url ?? null,
  keyFromUrl: () => null,
  objectUrl: (key) => `memory://${key}`,
}));

vi.mock('../infra/queues.js', () => ({
  enqueue: async (queue, name, data) => {
    if (!state.redisUp) {
      throw Object.assign(new Error('Background work is not available right now.'), {
        isAppError: true,
        status: 503,
        code: 'QUEUE_UNAVAILABLE',
      });
    }
    state.enqueued.push({ queue, name, data });
    return { id: String(state.enqueued.length) };
  },
}));

const { createApp } = await import('../app.js');
const { createSessionMiddleware } = await import('../middleware/session.js');
const { Role } = await import('../models/role.model.js');
const { User } = await import('../models/user.model.js');
const { runSeed } = await import('../seeds/seed.js');
const { createBackup, listBackups, restoreBackup } = await import('../services/backup.service.js');
const { JOB_HANDLERS, JOB_NAMES } = await import('../jobs/index.js');
const { clearTestDb, startTestDb, stopTestDb } = await import('./helpers/testDb.js');

const PASSWORD = 'correct-horse-battery';
const RESTORE_DB = 'crm_restore_check';
let app;
let ceo;
let manager;

const liveDb = () => mongoose.connection.db;
const restoreDb = () => mongoose.connection.getClient().db(RESTORE_DB);
const allOf = (db, name) => db.collection(name).find({}).sort({ _id: 1 }).toArray();

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
afterAll(async () => {
  await restoreDb().dropDatabase();
  await stopTestDb();
});

beforeEach(async () => {
  state.objects.clear();
  state.configured = true;
  state.enqueued = [];
  state.redisUp = true;
  await restoreDb().dropDatabase();
  await clearTestDb();
  await runSeed({ productName: 'P', companyName: 'C', workspaceDomain: 'engenx.in' });
  const roles = Object.fromEntries((await Role.find()).map((role) => [role.name, role]));
  const makeUser = (email, roleName) =>
    User.create({
      email,
      name: email,
      roleId: roles[roleName]._id,
      status: 'active',
      password: PASSWORD,
    });
  ceo = await makeUser('ceo@engenx.in', 'CEO');
  manager = await makeUser('manager@engenx.in', 'Sales Manager');
});

describe('database backup and restore', () => {
  it('a restored copy is identical: same documents, same exact types, same indexes', async () => {
    // A collection with the value types that a careless copy would damage.
    await liveDb()
      .collection('type_check')
      .insertMany([
        {
          _id: new mongoose.Types.ObjectId(),
          at: new Date('2026-10-09T04:30:00.123Z'),
          paise: 123456789012,
          whole: 42,
          fraction: 1.5,
          text: 'Line one\nLine two "quoted" ₹',
          nested: { ids: [new mongoose.Types.ObjectId()], flag: false, nothing: null },
        },
      ]);

    const backup = await createBackup();
    const result = await restoreBackup({ backupId: backup.id, targetDatabase: RESTORE_DB });
    expect(result.documents).toBe(backup.documents);

    for (const name of ['users', 'roles', 'settings', 'audit_logs', 'type_check']) {
      expect(await allOf(restoreDb(), name), name).toEqual(await allOf(liveDb(), name));
    }
    const [restored] = await allOf(restoreDb(), 'type_check');
    expect(restored._id).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(restored.at).toBeInstanceOf(Date);

    // Indexes come back too: the unique email rule still holds in the restored database.
    const indexNames = (db) =>
      db
        .collection('users')
        .indexes()
        .then((indexes) => indexes.map((index) => index.name).sort());
    expect(await indexNames(restoreDb())).toEqual(await indexNames(liveDb()));
    await expect(
      restoreDb().collection('users').insertOne({ email: ceo.email, name: 'Duplicate' }),
    ).rejects.toThrow(/duplicate key/);
  });

  it('writes large collections in several files and restores them completely', async () => {
    await liveDb()
      .collection('many')
      .insertMany(Array.from({ length: 25 }, (_, number) => ({ number })));
    const backup = await createBackup({ chunkDocuments: 10 });
    const files = [...state.objects.keys()].filter((key) => key.includes('/many/'));
    expect(files).toHaveLength(3); // 10 + 10 + 5

    await restoreBackup({ backupId: backup.id, targetDatabase: RESTORE_DB });
    expect(await restoreDb().collection('many').countDocuments()).toBe(25);
  });

  it('does not back up sign-in sessions', async () => {
    await signedInAs(ceo);
    expect(await liveDb().collection('sessions').countDocuments()).toBeGreaterThan(0);
    await createBackup();
    expect([...state.objects.keys()].some((key) => key.includes('/sessions/'))).toBe(false);
  });

  it('never restores over the live database or into a database that has data', async () => {
    const backup = await createBackup();
    await expect(
      restoreBackup({ backupId: backup.id, targetDatabase: mongoose.connection.name }),
    ).rejects.toMatchObject({ status: 409 });

    await restoreDb().collection('something').insertOne({ a: 1 });
    await expect(
      restoreBackup({ backupId: backup.id, targetDatabase: RESTORE_DB }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await restoreDb().collection('users').countDocuments()).toBe(0);

    await expect(
      restoreBackup({ backupId: backup.id, targetDatabase: 'bad name!' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      restoreBackup({ backupId: '2020-01-01T00-00-00Z', targetDatabase: RESTORE_DB }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('notices a backup with a missing or short file instead of restoring half of it', async () => {
    const backup = await createBackup();
    const usersFile = [...state.objects.keys()].find((key) => key.includes('/users/'));
    state.objects.delete(usersFile);
    await expect(
      restoreBackup({ backupId: backup.id, targetDatabase: RESTORE_DB }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('lists finished backups newest first, and an unfinished one is never offered', async () => {
    const first = await createBackup({ now: new Date('2026-10-01T20:30:00Z') });
    const second = await createBackup({ now: new Date('2026-10-02T20:30:00Z') });
    expect((await listBackups()).map((backup) => backup.id)).toEqual([second.id, first.id]);
    expect(first.id).toBe('2026-10-01T20-30-00Z');

    // Files of a backup that never wrote its manifest.
    state.objects.set('backups/2026-10-03T20-30-00Z/users/00001.jsonl.gz', Buffer.from('x'));
    expect(await listBackups()).toHaveLength(2);
    await expect(
      restoreBackup({ backupId: '2026-10-03T20-30-00Z', targetDatabase: RESTORE_DB }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('deletes backups older than 14 days but always keeps the newest 7', async () => {
    const day = (number) => new Date(Date.UTC(2026, 8, number, 20, 30));
    for (let number = 1; number <= 20; number += 1) await createBackup({ now: day(number) });
    // On day 20, days 1 to 5 are older than 14 days.
    const kept = (await listBackups()).map((backup) => backup.id);
    expect(kept).toHaveLength(15);
    expect(kept.at(-1)).toBe('2026-09-06T20-30-00Z');
    expect([...state.objects.keys()].some((key) => key.includes('2026-09-05T'))).toBe(false);

    // A backup after a long gap: everything is old, yet the newest 7 stay.
    const late = await createBackup({ now: new Date('2027-03-01T20:30:00Z') });
    expect(late.deleted).toHaveLength(9);
    expect(await listBackups()).toHaveLength(7);
  });

  it('the background job makes a backup, and is safe to run twice', async () => {
    const runBackup = JOB_HANDLERS[JOB_NAMES.databaseBackup];
    const first = await runBackup({}, { jobId: '1', attempt: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1100)); // ids are per second
    const second = await runBackup({}, { jobId: '1', attempt: 2 });
    expect(first.id).not.toBe(second.id);
    expect(await listBackups()).toHaveLength(2);
    await restoreBackup({ backupId: first.id, targetDatabase: RESTORE_DB });
  });
});

describe('backups API', () => {
  it('needs a session, and the settings permission', async () => {
    expect((await request(app).get('/api/backups')).status).toBe(401);
    const client = await signedInAs(manager);
    expect((await client.get('/api/backups')).status).toBe(403);
    expect((await client.post('/api/backups')).status).toBe(403);
  });

  it('lists the backups without any document content or file address', async () => {
    await createBackup();
    const response = await (await signedInAs(ceo)).get('/api/backups');
    expect(response.status).toBe(200);
    expect(response.body.data.storage).toBe('configured');
    expect(Object.keys(response.body.data.backups[0]).sort()).toEqual([
      'bytes',
      'collections',
      'createdAt',
      'documents',
      'id',
    ]);
    expect(JSON.stringify(response.body)).not.toContain(PASSWORD);
  });

  it('warns when the newest backup is more than two days old', async () => {
    const client = await signedInAs(ceo);
    const hoursAgo = (hours) => new Date(Date.now() - hours * 60 * 60 * 1000);

    await createBackup({ now: hoursAgo(72) });
    expect((await client.get('/api/backups')).body.data.isStale).toBe(true);
    await createBackup({ now: hoursAgo(20) });
    expect((await client.get('/api/backups')).body.data.isStale).toBe(false);
  });

  it('"back up now" adds one background job', async () => {
    const response = await (await signedInAs(ceo)).post('/api/backups');
    expect(response.status).toBe(201);
    expect(state.enqueued).toEqual([
      { queue: 'integrations', name: JOB_NAMES.databaseBackup, data: {} },
    ]);
  });

  it('says clearly when storage or the job queue is not available', async () => {
    const client = await signedInAs(ceo);
    state.redisUp = false;
    expect((await client.post('/api/backups')).body.error.code).toBe('QUEUE_UNAVAILABLE');

    state.configured = false;
    const overview = await client.get('/api/backups');
    expect(overview.body.data).toEqual({
      storage: 'not_configured',
      backups: [],
      isStale: false,
    });
    const start = await client.post('/api/backups');
    expect(start.status).toBe(503);
    expect(start.body.error.code).toBe('STORAGE_NOT_CONFIGURED');
  });

  it('offers no way to download or restore a backup over the API', async () => {
    const backup = await createBackup();
    const client = await signedInAs(ceo);
    expect((await client.get(`/api/backups/${backup.id}`)).status).toBe(404);
    expect((await client.post(`/api/backups/${backup.id}/restore`)).status).toBe(404);
    expect((await client.delete(`/api/backups/${backup.id}`)).status).toBe(404);
  });
});
