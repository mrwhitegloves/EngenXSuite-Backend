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

function makeUser(email, roleName, extra = {}) {
  return User.create({
    email,
    name: email.split('@')[0],
    roleId: roles[roleName]._id,
    status: 'active',
    password: PASSWORD,
    ...extra,
  });
}

const login = (email, password) => request(app).post('/api/auth/login').send({ email, password });

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
  it('signs in with the right password and returns the user without the password', async () => {
    const response = await login('CEO@engenx.in', PASSWORD);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ email: 'ceo@engenx.in', role: { name: 'CEO' } });
    expect(JSON.stringify(response.body)).not.toContain(PASSWORD);
    expect(response.headers['set-cookie'][0]).toMatch(/HttpOnly/);
  });

  it('gives the same answer for a wrong password, an unknown email and a deactivated user', async () => {
    await User.updateOne({ _id: otherAgent._id }, { $set: { status: 'deactivated' } });
    const attempts = await Promise.all([
      login(ceo.email, 'wrong-password'),
      login('nobody@x.com', PASSWORD),
      login(otherAgent.email, PASSWORD),
    ]);
    for (const attempt of attempts) {
      expect(attempt.status).toBe(401);
      expect(attempt.body.error.message).toBe(attempts[0].body.error.message);
      expect(attempt.headers['set-cookie']).toBeUndefined();
    }
  });

  it('refuses an account that has no password, and an empty password never matches', async () => {
    await User.create({ email: 'g@engenx.in', name: 'G', roleId: roles.CEO._id, status: 'active' });
    expect((await login('g@engenx.in', PASSWORD)).status).toBe(401);
    expect((await login('g@engenx.in', '')).status).toBe(400);
  });

  it('the password is case-sensitive and must match exactly', async () => {
    expect((await login(ceo.email, PASSWORD.toUpperCase())).status).toBe(401);
    expect((await login(ceo.email, `${PASSWORD} `)).status).toBe(401);
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

describe('password storage (decision 0011)', () => {
  it('stores the password exactly as typed, with no hash and no encryption', async () => {
    const client = await signedInAs(ceo);
    await client.post('/api/users').send({
      name: 'Plain',
      email: 'plain@engenx.in',
      password: 'My Plain Pass 123',
      roleId: String(roles['Sales Agent']._id),
    });
    const stored = await User.findOne({ email: 'plain@engenx.in' }).select('+password').lean();
    expect(stored.password).toBe('My Plain Pass 123');
    expect(Object.keys(stored)).not.toContain('passwordHash');
    expect(Object.keys(stored)).not.toContain('passwordEnc');
  });
});

describe('forgot password from the sign-in page (decision 0011)', () => {
  const reset = (email, newPassword) =>
    request(app).post('/api/auth/reset-password').send({ email, newPassword });

  it('sets a new password for an existing email without the old password or any email', async () => {
    const response = await reset('Agent@Engenx.in', NEW_PASSWORD);
    expect(response.status).toBe(200);
    expect((await login(agent.email, PASSWORD)).status).toBe(401);
    expect((await login(agent.email, NEW_PASSWORD)).status).toBe(200);
  });

  it('refuses an email that is not a user, and creates nobody', async () => {
    const response = await reset('nobody@example.com', NEW_PASSWORD);
    expect(response.status).toBe(404);
    expect(await User.countDocuments()).toBe(4);
  });

  it('refuses a deactivated user and a password that is too short', async () => {
    await User.updateOne({ _id: otherAgent._id }, { $set: { status: 'deactivated' } });
    expect((await reset(otherAgent.email, NEW_PASSWORD)).status).toBe(404);
    expect((await reset(agent.email, 'short')).status).toBe(400);
    expect((await login(agent.email, PASSWORD)).status).toBe(200); // unchanged
  });

  it('signs the user out everywhere and writes an audit entry without the password', async () => {
    const browser = await signedInAs(agent);
    await reset(agent.email, NEW_PASSWORD);
    expect((await browser.get('/api/auth/me')).status).toBe(401);

    const entries = await AuditLog.find({ action: 'user.password_reset_from_sign_in_page' }).lean();
    expect(entries).toHaveLength(1);
    expect(String(entries[0].entityId)).toBe(String(agent._id));
    expect(JSON.stringify(entries)).not.toContain(NEW_PASSWORD);
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

  it('the CEO creates an account and the new user signs in straight away', async () => {
    const client = await signedInAs(ceo);
    const created = await client.post('/api/users').send(newUser({ phone: '+919876543210' }));
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      email: 'new@engenx.in',
      status: 'active',
      avatarUrl: null,
      role: { name: 'Sales Agent' },
    });
    expect(JSON.stringify(created.body)).not.toContain(PASSWORD);

    const signedIn = await login('new@engenx.in', PASSWORD);
    expect(signedIn.status).toBe(200);
  });

  it('rejects a duplicate email, a short password and an unknown account type', async () => {
    const client = await signedInAs(ceo);
    expect((await client.post('/api/users').send(newUser({ email: agent.email }))).status).toBe(
      409,
    );
    expect((await client.post('/api/users').send(newUser({ password: 'short' }))).status).toBe(400);
    expect((await client.post('/api/users').send(newUser({ password: '7chars!' }))).status).toBe(
      400,
    );
    const unknownRole = await client
      .post('/api/users')
      .send(newUser({ roleId: '0123456789abcdef01234567' }));
    expect(unknownRole.status).toBe(400);
  });

  it('accepts a password of exactly 8 characters, the minimum', async () => {
    const client = await signedInAs(ceo);
    const created = await client.post('/api/users').send(newUser({ password: '8chars!!' }));
    expect(created.status).toBe(201);
    expect((await login('new@engenx.in', '8chars!!')).status).toBe(200);
  });

  it("a manager's new user reports to that manager by default", async () => {
    const client = await signedInAs(manager);
    const created = await client.post('/api/users').send(newUser());
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
    expect(forCeo.body.data.canLeaveManagerEmpty).toBe(true);
    const forManager = await (await signedInAs(manager)).get('/api/users/form-options');
    expect(forManager.body.data.roles.map((role) => role.name)).toEqual(['Sales Agent']);
    expect(forManager.body.data.canLeaveManagerEmpty).toBe(false);
  });

  it('a Sales Agent cannot reach any users endpoint', async () => {
    const client = await signedInAs(agent);
    expect((await client.get('/api/users')).status).toBe(403);
    expect((await client.get('/api/users/form-options')).status).toBe(403);
    expect((await client.post('/api/users').send(newUser())).status).toBe(403);
    expect((await client.patch(`/api/users/${otherAgent._id}`).send({ name: 'X' })).status).toBe(
      403,
    );
    expect((await client.get(`/api/users/${otherAgent._id}/password`)).status).toBe(403);
  });

  it('nobody reaches users endpoints without signing in', async () => {
    expect((await request(app).get('/api/users')).status).toBe(401);
    expect((await request(app).post('/api/users').send(newUser())).status).toBe(401);
    expect((await request(app).get(`/api/users/${agent._id}/password`)).status).toBe(401);
  });
});

describe('listing users', () => {
  it('the CEO sees everyone; a manager sees only their team and themselves', async () => {
    const all = await (await signedInAs(ceo)).get('/api/users');
    expect(all.body.meta.total).toBe(4);

    const team = await (await signedInAs(manager)).get('/api/users');
    expect(team.body.data.map((user) => user.email).sort()).toEqual([
      'agent@engenx.in',
      'manager@engenx.in',
    ]);
  });

  it('search stays inside what the person may see', async () => {
    const found = await (await signedInAs(manager)).get('/api/users?search=other');
    expect(found.body.data).toHaveLength(0);
  });

  it('the list never contains a password', async () => {
    const list = await (await signedInAs(ceo)).get('/api/users');
    expect(JSON.stringify(list.body)).not.toContain(PASSWORD);
    expect(JSON.stringify(list.body)).not.toMatch(/"password"/);
  });
});

describe('editing users (decision 0011)', () => {
  it('the CEO can change every field of a user', async () => {
    const client = await signedInAs(ceo);
    const response = await client.patch(`/api/users/${agent._id}`).send({
      name: 'Renamed Agent',
      email: 'Renamed@Gmail.com',
      password: NEW_PASSWORD,
      roleId: String(roles['Sales Manager']._id),
      managerId: String(ceo._id),
      phone: '+919812345678',
    });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      name: 'Renamed Agent',
      email: 'renamed@gmail.com',
      phone: '+919812345678',
      managerId: String(ceo._id),
      role: { name: 'Sales Manager' },
    });
    expect(JSON.stringify(response.body)).not.toContain(NEW_PASSWORD);

    // The old email and old password no longer work; the new ones do.
    expect((await login('agent@engenx.in', PASSWORD)).status).toBe(401);
    expect((await login('renamed@gmail.com', NEW_PASSWORD)).status).toBe(200);
    const stored = await User.findById(agent._id).lean();
    expect(stored.isWorkspaceAccount).toBe(false); // recalculated from the new email
  });

  it('changing the email forgets the old Google link', async () => {
    await User.updateOne({ _id: agent._id }, { $set: { googleId: 'g-123' } });
    await (await signedInAs(ceo)).patch(`/api/users/${agent._id}`).send({ email: 'x@engenx.in' });
    expect((await User.findById(agent._id).lean()).googleId).toBeUndefined();
  });

  it('refuses an email that another user already has', async () => {
    const response = await (
      await signedInAs(ceo)
    )
      .patch(`/api/users/${agent._id}`)
      .send({ email: otherAgent.email });
    expect(response.status).toBe(409);
  });

  it("a password changed by an administrator signs that user out; the user's own session rule is separate", async () => {
    const agentBrowser = await signedInAs(agent);
    await (
      await signedInAs(manager)
    )
      .patch(`/api/users/${agent._id}`)
      .send({ password: NEW_PASSWORD });
    expect((await agentBrowser.get('/api/auth/me')).status).toBe(401);
    expect((await login(agent.email, NEW_PASSWORD)).status).toBe(200);
  });

  it('a manager edits their own team, including moving an agent to another manager', async () => {
    const client = await signedInAs(manager);
    const renamed = await client.patch(`/api/users/${agent._id}`).send({ name: 'Team Member' });
    expect(renamed.status).toBe(200);

    const moved = await client
      .patch(`/api/users/${agent._id}`)
      .send({ managerId: String(ceo._id) });
    expect(moved.status).toBe(200);
    expect(moved.body.data.managerId).toBe(String(ceo._id));
    // The agent now reports to someone else, so this manager no longer sees or edits them.
    expect((await client.patch(`/api/users/${agent._id}`).send({ name: 'Back' })).status).toBe(404);
  });

  it('a manager gets 404 for users outside their team and cannot promote to manager', async () => {
    const client = await signedInAs(manager);
    expect((await client.patch(`/api/users/${otherAgent._id}`).send({ name: 'X' })).status).toBe(
      404,
    );
    expect((await client.patch(`/api/users/${ceo._id}`).send({ name: 'X' })).status).toBe(404);
    expect((await client.patch(`/api/users/${manager._id}`).send({ name: 'Me' })).status).toBe(404);
    const promote = await client
      .patch(`/api/users/${agent._id}`)
      .send({ roleId: String(roles['Sales Manager']._id) });
    expect(promote.status).toBe(403);
    const noManager = await client.patch(`/api/users/${agent._id}`).send({ managerId: null });
    expect(noManager.status).toBe(400);
  });

  it('the CEO can edit their own account but not deactivate it', async () => {
    const client = await signedInAs(ceo);
    const response = await client
      .patch(`/api/users/${ceo._id}`)
      .send({ name: 'The Boss', password: NEW_PASSWORD });
    expect(response.status).toBe(200);
    expect((await client.get('/api/auth/me')).status).toBe(200); // own session is kept
    expect(
      (await client.patch(`/api/users/${ceo._id}`).send({ status: 'deactivated' })).status,
    ).toBe(409);
  });

  it('deactivating a user signs them out at once and blocks sign-in; activating restores it', async () => {
    const agentClient = await signedInAs(agent);
    const ceoClient = await signedInAs(ceo);
    const off = await ceoClient.patch(`/api/users/${agent._id}`).send({ status: 'deactivated' });
    expect(off.body.data.status).toBe('deactivated');
    expect((await agentClient.get('/api/auth/me')).status).toBe(401);
    expect((await login(agent.email, PASSWORD)).status).toBe(401);

    await ceoClient.patch(`/api/users/${agent._id}`).send({ status: 'active' });
    expect((await login(agent.email, PASSWORD)).status).toBe(200);
  });

  it('the last administrator cannot be demoted', async () => {
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

describe('viewing passwords', () => {
  const view = (client, user) => client.get(`/api/users/${user._id}/password`);

  it('the CEO sees the password of any user; the response is not cacheable', async () => {
    const response = await view(await signedInAs(ceo), otherAgent);
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ password: PASSWORD, available: true });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('a manager sees only their own team; anyone else is 404', async () => {
    const client = await signedInAs(manager);
    expect((await view(client, agent)).body.data.password).toBe(PASSWORD);
    expect((await view(client, otherAgent)).status).toBe(404);
    expect((await view(client, ceo)).status).toBe(404);
  });

  it('shows the password the user set themselves from the sign-in page', async () => {
    await request(app)
      .post('/api/auth/reset-password')
      .send({ email: agent.email, newPassword: NEW_PASSWORD });
    const response = await view(await signedInAs(ceo), agent);
    expect(response.body.data.password).toBe(NEW_PASSWORD);
  });

  it('says "not available" for a user without a password', async () => {
    const noPassword = await User.create({
      email: 'google-only@engenx.in',
      name: 'Google Only',
      roleId: roles['Sales Agent']._id,
      status: 'active',
    });
    const response = await view(await signedInAs(ceo), noPassword);
    expect(response.body.data).toEqual({ password: null, available: false });
  });
});

describe('audit log', () => {
  it('records who did what and never contains a password', async () => {
    const client = await signedInAs(ceo);
    await client.post('/api/users').send({
      name: 'Audited',
      email: 'audited@engenx.in',
      password: PASSWORD,
      roleId: String(roles['Sales Agent']._id),
    });
    await client
      .patch(`/api/users/${agent._id}`)
      .send({ name: 'New Name', password: NEW_PASSWORD });
    await client.get(`/api/users/${agent._id}/password`);

    const entries = await AuditLog.find().sort({ at: 1 }).lean();
    expect(entries.map((entry) => entry.action).sort()).toEqual([
      'user.created',
      'user.password_changed_by_admin',
      'user.password_viewed',
      'user.updated',
    ]);
    expect(entries.every((entry) => String(entry.userId) === String(ceo._id))).toBe(true);
    const everything = JSON.stringify(entries);
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain(NEW_PASSWORD);
  });
});
