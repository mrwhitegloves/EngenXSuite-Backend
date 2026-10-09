import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { createSessionMiddleware } from '../middleware/session.js';
import { AuditLog } from '../models/auditLog.model.js';
import { Role } from '../models/role.model.js';
import { User } from '../models/user.model.js';
import { ACTIONS, FEATURES } from '../constants/permissions.js';
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

const makeUser = (email, roleName) =>
  User.create({
    email,
    name: email,
    roleId: roles[roleName]._id,
    status: 'active',
    password: PASSWORD,
  });

beforeAll(async () => {
  await startTestDb();
  app = createApp({ sessionMiddleware: createSessionMiddleware() });
});
afterAll(stopTestDb);

beforeEach(async () => {
  await clearTestDb();
  await runSeed({ productName: 'P', companyName: 'C', workspaceDomain: 'engenx.in' });
  roles = Object.fromEntries((await Role.find()).map((role) => [role.name, role]));
  ceo = await makeUser('ceo@engenx.in', 'CEO');
  manager = await makeUser('manager@engenx.in', 'Sales Manager');
  agent = await makeUser('agent@engenx.in', 'Sales Agent');
});

describe('roles and permissions', () => {
  it('the CEO sees every account type, its user count and what can be granted', async () => {
    const response = await (await signedInAs(ceo)).get('/api/roles');
    expect(response.status).toBe(200);
    const byName = Object.fromEntries(response.body.data.roles.map((role) => [role.name, role]));
    expect(Object.keys(byName).sort()).toEqual(['CEO', 'Sales Agent', 'Sales Manager']);
    expect(byName.CEO.userCount).toBe(1);
    expect(byName.CEO.isSystem).toBe(true);
    expect(response.body.data.catalogue.features).toEqual(FEATURES);
    expect(response.body.data.catalogue.actions).toEqual(ACTIONS);
  });

  it('only someone with the settings permission reaches these endpoints', async () => {
    for (const user of [manager, agent]) {
      const client = await signedInAs(user);
      expect((await client.get('/api/roles')).status).toBe(403);
      expect(
        (await client.patch(`/api/roles/${roles['Sales Agent']._id}`).send({ grants: [] })).status,
      ).toBe(403);
      expect((await client.post('/api/roles').send({ name: 'Mine' })).status).toBe(403);
    }
    expect((await request(app).get('/api/roles')).status).toBe(401);
  });

  it('a permission change applies to users of that type on their next request', async () => {
    const agentClient = await signedInAs(agent);
    expect((await agentClient.get('/api/users')).status).toBe(403);

    const grants = [
      ...roles['Sales Agent'].grants.map(({ feature, action, scope }) => ({
        feature,
        action,
        scope,
      })),
      { feature: 'users', action: 'view', scope: 'team' },
    ];
    const update = await (
      await signedInAs(ceo)
    )
      .patch(`/api/roles/${roles['Sales Agent']._id}`)
      .send({ grants });
    expect(update.status).toBe(200);

    expect((await agentClient.get('/api/users')).status).toBe(200);
    const me = await agentClient.get('/api/auth/me');
    expect(me.body.data.grants).toContainEqual({ feature: 'users', action: 'view', scope: 'team' });
  });

  it('rejects unknown features, actions, scopes and duplicate entries', async () => {
    const client = await signedInAs(ceo);
    const id = roles['Sales Agent']._id;
    const bad = [
      [{ feature: 'nuclear_codes', action: 'view', scope: 'all' }],
      [{ feature: 'accounts', action: 'obliterate', scope: 'all' }],
      [{ feature: 'accounts', action: 'view', scope: 'galaxy' }],
      [
        { feature: 'accounts', action: 'view', scope: 'own' },
        { feature: 'accounts', action: 'view', scope: 'all' },
      ],
    ];
    for (const grants of bad) {
      expect((await client.patch(`/api/roles/${id}`).send({ grants })).status).toBe(400);
    }
  });

  it('refuses a change that would leave nobody able to manage settings and users', async () => {
    const client = await signedInAs(ceo);
    const withoutSettings = roles.CEO.grants
      .filter((grant) => grant.feature !== 'settings')
      .map(({ feature, action, scope }) => ({ feature, action, scope }));
    const response = await client
      .patch(`/api/roles/${roles.CEO._id}`)
      .send({ grants: withoutSettings });
    expect(response.status).toBe(409);
    expect((await Role.findById(roles.CEO._id)).grants.length).toBe(roles.CEO.grants.length);
  });

  it('creates, renames and deletes a custom account type, with rules for built-in ones', async () => {
    const client = await signedInAs(ceo);
    const created = await client.post('/api/roles').send({
      name: 'Accounts Team',
      description: 'Invoices only',
      grants: [{ feature: 'invoices', action: 'view', scope: 'all' }],
    });
    expect(created.status).toBe(201);
    const id = created.body.data.id;

    expect((await client.post('/api/roles').send({ name: 'Accounts Team' })).status).toBe(409);
    expect((await client.patch(`/api/roles/${id}`).send({ name: 'Finance' })).body.data.name).toBe(
      'Finance',
    );
    expect((await client.patch(`/api/roles/${roles.CEO._id}`).send({ name: 'Boss' })).status).toBe(
      409,
    );
    expect((await client.delete(`/api/roles/${roles['Sales Agent']._id}`)).status).toBe(409);

    await User.create({ email: 'f@engenx.in', name: 'F', roleId: id, status: 'active' });
    expect((await client.delete(`/api/roles/${id}`)).status).toBe(409); // a user still has it
    await User.deleteOne({ email: 'f@engenx.in' });
    expect((await client.delete(`/api/roles/${id}`)).status).toBe(200);
  });

  it('writes audit entries for role changes', async () => {
    const client = await signedInAs(ceo);
    await client.patch(`/api/roles/${roles['Sales Agent']._id}`).send({ description: 'Changed' });
    const entries = await AuditLog.find({ action: 'role.updated' }).lean();
    expect(entries).toHaveLength(1);
    expect(String(entries[0].userId)).toBe(String(ceo._id));
  });
});
