import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { createSessionMiddleware } from '../middleware/session.js';
import { AuditLog } from '../models/auditLog.model.js';
import { Role } from '../models/role.model.js';
import { User } from '../models/user.model.js';
import { runSeed } from '../seeds/seed.js';
import { clearTestDb, startTestDb, stopTestDb } from './helpers/testDb.js';

const PASSWORD = 'correct-horse-battery';
let app;
let roles;
let ceo;
let manager;
let agent;

async function signedInAs(user) {
  const client = request.agent(app);
  const response = await client
    .post('/api/auth/login')
    .send({ email: user.email, password: PASSWORD });
  expect(response.status).toBe(200);
  return client;
}

const indiaTime = (text) => new Date(`${text}+05:30`);

beforeAll(async () => {
  await startTestDb();
  app = createApp({ sessionMiddleware: createSessionMiddleware() });
});
afterAll(stopTestDb);

beforeEach(async () => {
  await clearTestDb();
  await runSeed({ productName: 'P', companyName: 'C', workspaceDomain: 'engenx.in' });
  roles = Object.fromEntries((await Role.find()).map((role) => [role.name, role]));
  const makeUser = (email, name, roleName) =>
    User.create({ email, name, roleId: roles[roleName]._id, status: 'active', password: PASSWORD });
  ceo = await makeUser('ceo@engenx.in', 'Kunal CEO', 'CEO');
  manager = await makeUser('manager@engenx.in', 'Meera Manager', 'Sales Manager');
  agent = await makeUser('agent@engenx.in', 'Asha Agent', 'Sales Agent');

  // Start from known entries only (the seed writes its own).
  await AuditLog.deleteMany({});
  await AuditLog.create([
    {
      userId: ceo._id,
      action: 'user.updated',
      entityType: 'users',
      entityId: agent._id,
      oldValue: { name: 'Asha' },
      newValue: { name: 'Asha Agent' },
      at: indiaTime('2026-10-01T10:00:00'),
    },
    {
      userId: manager._id,
      action: 'user.created',
      entityType: 'users',
      entityId: agent._id,
      at: indiaTime('2026-10-05T23:59:00'),
    },
    {
      userId: ceo._id,
      action: 'role.updated',
      entityType: 'roles',
      entityId: roles['Sales Agent']._id,
      at: indiaTime('2026-10-06T00:00:00'),
    },
    {
      userId: null,
      action: 'role.created',
      entityType: 'roles',
      entityId: roles.CEO._id,
      at: indiaTime('2026-09-20T12:00:00'),
    },
  ]);
});

describe('audit log', () => {
  it('needs a session, and the audit permission', async () => {
    expect((await request(app).get('/api/audit-logs')).status).toBe(401);
    for (const user of [manager, agent]) {
      const client = await signedInAs(user);
      expect((await client.get('/api/audit-logs')).status).toBe(403);
      expect((await client.get('/api/audit-logs/options')).status).toBe(403);
    }
  });

  it('lists entries newest first, with the names of who and of which record', async () => {
    const response = await (await signedInAs(ceo)).get('/api/audit-logs');
    expect(response.status).toBe(200);
    expect(response.body.meta).toEqual({ page: 1, pageSize: 25, total: 4 });
    expect(response.body.data.map((entry) => entry.action)).toEqual([
      'role.updated',
      'user.created',
      'user.updated',
      'role.created',
    ]);
    expect(response.body.data[0]).toMatchObject({
      user: { id: String(ceo._id), name: 'Kunal CEO' },
      entityType: 'roles',
      entityName: 'Sales Agent',
    });
    expect(response.body.data[2]).toMatchObject({
      entityName: 'Asha Agent',
      oldValue: { name: 'Asha' },
      newValue: { name: 'Asha Agent' },
    });
    // Written by the system itself: no user.
    expect(response.body.data[3].user).toBeNull();
  });

  it('never shows a password, even if one was stored in a user record', async () => {
    const response = await (await signedInAs(ceo)).get('/api/audit-logs');
    expect(JSON.stringify(response.body)).not.toContain(PASSWORD);
  });

  it('filters by user, by record type and by action, also combined', async () => {
    const client = await signedInAs(ceo);
    const actionsFor = async (query) =>
      (await client.get(`/api/audit-logs?${query}`)).body.data.map((entry) => entry.action);

    expect(await actionsFor(`userId=${manager._id}`)).toEqual(['user.created']);
    expect(await actionsFor('userId=system')).toEqual(['role.created']);
    expect(await actionsFor('entityType=roles')).toEqual(['role.updated', 'role.created']);
    expect(await actionsFor('action=user.updated')).toEqual(['user.updated']);
    expect(await actionsFor(`userId=${ceo._id}&entityType=users`)).toEqual(['user.updated']);
    expect(await actionsFor(`userId=${manager._id}&entityType=roles`)).toEqual([]);
  });

  it('filters by date with India-time days and an included end day', async () => {
    const client = await signedInAs(ceo);
    const actionsFor = async (query) =>
      (await client.get(`/api/audit-logs?${query}`)).body.data.map((entry) => entry.action);

    // 23:59 on the 5th is inside "1st to 5th"; 00:00 on the 6th is not.
    expect(await actionsFor('range=custom&from=2026-10-01&to=2026-10-05')).toEqual([
      'user.created',
      'user.updated',
    ]);
    expect(await actionsFor('range=custom&from=2026-10-06&to=2026-10-06')).toEqual([
      'role.updated',
    ]);
    expect(await actionsFor('range=custom&from=2026-09-01&to=2026-09-30&entityType=roles')).toEqual(
      ['role.created'],
    );
  });

  it('rejects wrong filters with 400', async () => {
    const client = await signedInAs(ceo);
    for (const query of [
      'range=custom&from=2026-10-09&to=2026-10-01',
      'range=custom&from=2026-10-01',
      'range=sometime',
      'from=2026-10-01&to=2026-10-02',
      'userId=not-an-id',
      'action=$ne',
      'entityType=a b',
      'pageSize=1000',
    ]) {
      expect((await client.get(`/api/audit-logs?${query}`)).status, query).toBe(400);
    }
  });

  it('a database operator smuggled into the address is ignored, not run', async () => {
    const client = await signedInAs(ceo);
    // The server does not turn "action[$ne]" into an object, so it is an unknown name: dropped.
    const response = await client.get('/api/audit-logs?action[$ne]=user.updated');
    expect(response.status).toBe(200);
    expect(response.body.meta.total).toBe(4); // not "everything except user.updated" (3)
  });

  it('pages through the entries', async () => {
    const client = await signedInAs(ceo);
    const second = await client.get('/api/audit-logs?page=2&pageSize=3');
    expect(second.body.meta).toEqual({ page: 2, pageSize: 3, total: 4 });
    expect(second.body.data.map((entry) => entry.action)).toEqual(['role.created']);
  });

  it('offers the filter values that exist', async () => {
    const response = await (await signedInAs(ceo)).get('/api/audit-logs/options');
    expect(response.status).toBe(200);
    expect(response.body.data.entityTypes).toEqual(['roles', 'users']);
    expect(response.body.data.actions).toEqual([
      'role.created',
      'role.updated',
      'user.created',
      'user.updated',
    ]);
    expect(response.body.data.users.map((user) => user.name)).toEqual([
      'Asha Agent',
      'Kunal CEO',
      'Meera Manager',
    ]);
    expect(JSON.stringify(response.body)).not.toContain('engenx.in'); // names only, no emails
  });

  it('is read-only: no route changes or deletes an entry', async () => {
    const client = await signedInAs(ceo);
    const entry = await AuditLog.findOne().lean();
    for (const method of ['post', 'put', 'patch', 'delete']) {
      expect((await client[method]('/api/audit-logs').send({})).status).toBe(404);
      expect((await client[method](`/api/audit-logs/${entry._id}`).send({})).status).toBe(404);
    }
    expect(await AuditLog.countDocuments()).toBe(4);
  });
});
