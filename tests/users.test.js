import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createApp } from '../app.js';
import { createSessionMiddleware } from '../middleware/session.js';
import { createLoginLimiter } from '../middleware/rateLimit.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { AuditLog } from '../models/auditLog.model.js';
import { Role } from '../models/role.model.js';
import { User } from '../models/user.model.js';
import { hashPassword } from '../infra/password.js';
import { runSeed } from '../seeds/seed.js';
import { clearTestDb, startTestDb, stopTestDb } from './helpers/testDb.js';

// Real app, real session store (in the in-memory MongoDB), real sign-in through /api/auth/login.

const PASSWORD = 'correct-horse-battery';
const NEW_PASSWORD = 'another-strong-secret';
let app;
let roles;
let ceo;
let manager;
let agent;
let otherAgent;

async function makeUser(email, roleName, extra = {}) {
  return User.create({
    email,
    name: email.split('@')[0],
    roleId: roles[roleName]._id,
    status: 'active',
    passwordHash: await hashPassword(PASSWORD),
    ...extra,
  });
}

/** A browser-like client that is signed in as this user. */
async function signedInAs(user, password = PASSWORD) {
  const client = request.agent(app);
  const response = await client.post('/api/auth/login').send({ email: user.email, password });
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
  await runSeed({ productName: 'P', companyName: 'C', workspaceDomain: 'engenx.in' });
  roles = Object.fromEntries((await Role.find()).map((role) => [role.name, role]));
  ceo = await makeUser('ceo@engenx.in', 'CEO');
  manager = await makeUser('manager@engenx.in', 'Sales Manager');
  agent = await makeUser('agent@engenx.in', 'Sales Agent', { managerId: manager._id });
  otherAgent = await makeUser('other@engenx.in', 'Sales Agent');
});

describe('email + password sign-in', () => {
  it('signs in with the right password and returns the user without any secret', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'CEO@engenx.in', password: PASSWORD });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ email: 'ceo@engenx.in', role: { name: 'CEO' } });
    expect(JSON.stringify(response.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
    expect(response.headers['set-cookie'][0]).toMatch(/HttpOnly/);
  });

  it('gives the same answer for a wrong password, an unknown email and a deactivated user', async () => {
    await User.updateOne({ _id: otherAgent._id }, { $set: { status: 'deactivated' } });
    const attempts = await Promise.all([
      request(app).post('/api/auth/login').send({ email: ceo.email, password: 'wrong-password' }),
      request(app).post('/api/auth/login').send({ email: 'nobody@x.com', password: PASSWORD }),
      request(app).post('/api/auth/login').send({ email: otherAgent.email, password: PASSWORD }),
    ]);
    for (const attempt of attempts) {
      expect(attempt.status).toBe(401);
      expect(attempt.body.error.message).toBe(attempts[0].body.error.message);
      expect(attempt.headers['set-cookie']).toBeUndefined();
    }
  });

  it('refuses an account that has no password (for example one that only uses Google)', async () => {
    await User.create({ email: 'g@engenx.in', name: 'G', roleId: roles.CEO._id, status: 'active' });
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'g@engenx.in', password: PASSWORD });
    expect(response.status).toBe(401);
  });

  it('rejects a malformed request with 400', async () => {
    const response = await request(app).post('/api/auth/login').send({ email: 'not-an-email' });
    expect(response.status).toBe(400);
  });
});

describe('sign-in rate limit', () => {
  it('blocks after the limit with 429, Retry-After and the standard error shape', async () => {
    const limited = express();
    limited.use(express.json());
    limited.post('/login', createLoginLimiter({ limit: 2, skip: () => false }), (req, res) =>
      res.status(401).json({ error: { code: 'UNAUTHORIZED' } }),
    );
    limited.use(errorHandler);

    const attempt = () => request(limited).post('/login').send({ email: 'a@b.com', password: 'x' });
    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(401);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    // A different email from the same address has its own counter.
    const other = await request(limited).post('/login').send({ email: 'c@d.com', password: 'x' });
    expect(other.status).toBe(401);
  });
});

describe('creating user accounts', () => {
  const newUser = (overrides = {}) => ({
    name: 'New Person',
    email: 'new@engenx.in',
    password: PASSWORD,
    roleId: String(roles['Sales Agent']._id),
    ...overrides,
  });

  it('the CEO creates an account; the new user can sign in and must choose a password', async () => {
    const client = await signedInAs(ceo);
    const created = await client.post('/api/users').send(newUser({ phone: '+919876543210' }));
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      email: 'new@engenx.in',
      status: 'active',
      mustChangePassword: true,
      role: { name: 'Sales Agent' },
    });
    expect(JSON.stringify(created.body)).not.toMatch(/password"|passwordHash/);

    const stored = await User.findOne({ email: 'new@engenx.in' }).select('+passwordHash');
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(stored.passwordHash).not.toContain(PASSWORD);

    const newClient = request.agent(app);
    const login = await newClient
      .post('/api/auth/login')
      .send({ email: 'new@engenx.in', password: PASSWORD });
    expect(login.body.data.mustChangePassword).toBe(true);
  });

  it('rejects a duplicate email, a short password and an unknown account type', async () => {
    const client = await signedInAs(ceo);
    expect((await client.post('/api/users').send(newUser({ email: agent.email }))).status).toBe(
      409,
    );
    expect((await client.post('/api/users').send(newUser({ password: 'short' }))).status).toBe(400);
    const unknownRole = await client
      .post('/api/users')
      .send(newUser({ roleId: '0123456789abcdef01234567' }));
    expect(unknownRole.status).toBe(400);
  });

  it("a manager's new user always reports to that manager", async () => {
    const client = await signedInAs(manager);
    const created = await client.post('/api/users').send(newUser({ managerId: String(ceo._id) })); // tries to place them under someone else
    expect(created.status).toBe(201);
    expect(created.body.data.managerId).toBe(String(manager._id));
  });

  it('a manager cannot create a manager or CEO account', async () => {
    const client = await signedInAs(manager);
    for (const roleName of ['Sales Manager', 'CEO']) {
      const response = await client
        .post('/api/users')
        .send(newUser({ roleId: String(roles[roleName]._id) }));
      expect(response.status).toBe(403);
    }
    expect(await User.countDocuments({ email: 'new@engenx.in' })).toBe(0);
  });

  it('form options list only the account types the person may give', async () => {
    const forCeo = await (await signedInAs(ceo)).get('/api/users/form-options');
    expect(forCeo.body.data.roles.map((role) => role.name).sort()).toEqual([
      'CEO',
      'Sales Agent',
      'Sales Manager',
    ]);
    const forManager = await (await signedInAs(manager)).get('/api/users/form-options');
    expect(forManager.body.data.roles.map((role) => role.name)).toEqual(['Sales Agent']);
    expect(forManager.body.data.canChooseManager).toBe(false);
  });

  it('a Sales Agent cannot reach any users endpoint', async () => {
    const client = await signedInAs(agent);
    expect((await client.get('/api/users')).status).toBe(403);
    expect((await client.get('/api/users/form-options')).status).toBe(403);
    expect((await client.post('/api/users').send(newUser())).status).toBe(403);
    expect((await client.patch(`/api/users/${otherAgent._id}`).send({ name: 'X' })).status).toBe(
      403,
    );
  });

  it('nobody reaches users endpoints without signing in', async () => {
    expect((await request(app).get('/api/users')).status).toBe(401);
    expect((await request(app).post('/api/users').send(newUser())).status).toBe(401);
  });
});

describe('listing and managing users', () => {
  it('the CEO sees everyone; a manager sees only their team and themselves', async () => {
    const all = await (await signedInAs(ceo)).get('/api/users');
    expect(all.body.meta.total).toBe(4);

    const team = await (await signedInAs(manager)).get('/api/users');
    expect(team.body.data.map((user) => user.email).sort()).toEqual([
      'agent@engenx.in',
      'manager@engenx.in',
    ]);
  });

  it('search and filters stay inside what the person may see', async () => {
    const client = await signedInAs(manager);
    const found = await client.get('/api/users?search=other');
    expect(found.body.data).toHaveLength(0);
  });

  it('a manager gets 404 when editing or resetting a user outside their team', async () => {
    const client = await signedInAs(manager);
    expect((await client.patch(`/api/users/${otherAgent._id}`).send({ name: 'X' })).status).toBe(
      404,
    );
    const reset = await client
      .post(`/api/users/${otherAgent._id}/reset-password`)
      .send({ password: NEW_PASSWORD });
    expect(reset.status).toBe(404);
    expect((await client.patch(`/api/users/${ceo._id}`).send({ name: 'X' })).status).toBe(404);
  });

  it('a manager cannot promote a team member to manager', async () => {
    const client = await signedInAs(manager);
    const response = await client
      .patch(`/api/users/${agent._id}`)
      .send({ roleId: String(roles['Sales Manager']._id) });
    expect(response.status).toBe(403);
  });

  it('deactivating a user signs them out at once and blocks sign-in', async () => {
    const agentClient = await signedInAs(agent);
    expect((await agentClient.get('/api/auth/me')).status).toBe(200);

    const ceoClient = await signedInAs(ceo);
    const response = await ceoClient
      .patch(`/api/users/${agent._id}`)
      .send({ status: 'deactivated' });
    expect(response.body.data.status).toBe('deactivated');

    expect((await agentClient.get('/api/auth/me')).status).toBe(401);
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: agent.email, password: PASSWORD });
    expect(login.status).toBe(401);
  });

  it('nobody can deactivate themselves, and the last administrator cannot be removed', async () => {
    const client = await signedInAs(ceo);
    expect(
      (await client.patch(`/api/users/${ceo._id}`).send({ status: 'deactivated' })).status,
    ).toBe(409);

    // A second CEO exists, then tries to demote the first while being the only other admin.
    const second = await makeUser('ceo2@engenx.in', 'CEO');
    const secondClient = await signedInAs(second);
    const demoteFirst = await secondClient
      .patch(`/api/users/${ceo._id}`)
      .send({ roleId: String(roles['Sales Agent']._id) });
    expect(demoteFirst.status).toBe(200); // fine: the second CEO remains

    const demoteSelf = await secondClient
      .patch(`/api/users/${second._id}`)
      .send({ roleId: String(roles['Sales Agent']._id) });
    expect(demoteSelf.status).toBe(409); // would leave no administrator
  });
});

describe('passwords', () => {
  it('a user who must change their password can do nothing else until they do', async () => {
    await User.updateOne({ _id: manager._id }, { $set: { mustChangePassword: true } });
    const client = await signedInAs(manager);

    const blocked = await client.get('/api/users');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await client.get('/api/auth/me')).body.data.mustChangePassword).toBe(true);

    const changed = await client
      .post('/api/auth/password')
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(changed.status).toBe(200);
    expect(changed.body.data.mustChangePassword).toBe(false);
    expect((await client.get('/api/users')).status).toBe(200);
  });

  it('changing a password needs the current one and ends the other sessions', async () => {
    const here = await signedInAs(agent);
    const elsewhere = await signedInAs(agent);

    const wrong = await here
      .post('/api/auth/password')
      .send({ currentPassword: 'not-my-password', newPassword: NEW_PASSWORD });
    expect(wrong.status).toBe(400);

    const ok = await here
      .post('/api/auth/password')
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(ok.status).toBe(200);

    expect((await here.get('/api/auth/me')).status).toBe(200); // this browser stays signed in
    expect((await elsewhere.get('/api/auth/me')).status).toBe(401); // the other one is signed out

    const oldPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: agent.email, password: PASSWORD });
    expect(oldPassword.status).toBe(401);
    await signedInAs(agent, NEW_PASSWORD);
  });

  it('a reset by the manager signs the user out and forces a new password', async () => {
    const agentClient = await signedInAs(agent);
    const managerClient = await signedInAs(manager);

    const reset = await managerClient
      .post(`/api/users/${agent._id}/reset-password`)
      .send({ password: NEW_PASSWORD });
    expect(reset.status).toBe(200);

    expect((await agentClient.get('/api/auth/me')).status).toBe(401);
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: agent.email, password: NEW_PASSWORD });
    expect(login.body.data.mustChangePassword).toBe(true);
  });

  it('the audit log records who did what and never contains a password', async () => {
    const client = await signedInAs(ceo);
    await client.post('/api/users').send({
      name: 'Audited',
      email: 'audited@engenx.in',
      password: PASSWORD,
      roleId: String(roles['Sales Agent']._id),
    });
    await client.post(`/api/users/${agent._id}/reset-password`).send({ password: NEW_PASSWORD });

    const entries = await AuditLog.find().lean();
    expect(entries.map((entry) => entry.action).sort()).toEqual([
      'user.created',
      'user.password_reset',
    ]);
    expect(String(entries[0].userId)).toBe(String(ceo._id));
    const everything = JSON.stringify(entries);
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain(NEW_PASSWORD);
    expect(everything).not.toMatch(/\$2[aby]\$/);
  });
});
