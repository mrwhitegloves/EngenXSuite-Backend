import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import session from 'express-session';
import { createApp } from '../app.js';
import { Role } from '../models/role.model.js';
import { User } from '../models/user.model.js';
import { Settings } from '../models/settings.model.js';
import { runSeed } from '../seeds/seed.js';
import { loadRequestUser, signInWithGoogle } from '../services/auth.service.js';
import { clearTestDb, startTestDb, stopTestDb } from './helpers/testDb.js';

const SEED = {
  ceoEmail: 'Boss@Engenx.in',
  productName: 'TestProduct',
  companyName: 'TestCo',
  workspaceDomain: 'engenx.in',
};
const OPTIONS = { workspaceDomain: 'engenx.in' };

beforeAll(startTestDb);
afterAll(stopTestDb);
beforeEach(async () => {
  await clearTestDb();
  await runSeed(SEED);
});

async function inviteUser(email, roleName, extra = {}) {
  const role = await Role.findOne({ name: roleName });
  return User.create({ email, name: email, roleId: role._id, status: 'invited', ...extra });
}

describe('seed', () => {
  it('creates the three roles, the settings record and the first CEO as invited', async () => {
    expect(await Role.countDocuments()).toBe(3);
    const settings = await Settings.findOne({ key: 'app' });
    expect(settings.branding.productName).toBe('TestProduct');
    const ceo = await User.findOne({ email: 'boss@engenx.in' });
    expect(ceo.status).toBe('invited');
    expect(ceo.isWorkspaceAccount).toBe(true);
  });

  it('is safe to run twice and never overwrites changes made in the app', async () => {
    await Role.updateOne({ name: 'Sales Agent' }, { $set: { grants: [] } });
    await Settings.updateOne({ key: 'app' }, { $set: { 'branding.productName': 'Renamed' } });

    const second = await runSeed({ ...SEED, ceoEmail: 'other@engenx.in' });

    expect(second).toEqual({ rolesCreated: [], settingsCreated: false, ceoCreated: false });
    expect(await Role.countDocuments()).toBe(3);
    expect(await User.countDocuments()).toBe(1);
    expect((await Role.findOne({ name: 'Sales Agent' })).grants).toHaveLength(0);
    expect((await Settings.findOne({ key: 'app' })).branding.productName).toBe('Renamed');
  });
});

describe('signInWithGoogle (invite-only)', () => {
  const googleProfile = (overrides = {}) => ({
    googleId: 'g-1',
    email: 'boss@engenx.in',
    emailVerified: true,
    name: 'The Boss',
    avatarUrl: 'https://example.com/a.png',
    ...overrides,
  });

  it('activates an invited user on first sign-in and fills in the profile', async () => {
    const { userId } = await signInWithGoogle(googleProfile({ email: 'BOSS@engenx.in' }), OPTIONS);
    const user = await User.findById(userId);
    expect(user.status).toBe('active');
    expect(user.googleId).toBe('g-1');
    expect(user.name).toBe('The Boss');
    expect(user.lastLoginAt).toBeInstanceOf(Date);
  });

  it('refuses a Google account that was never invited', async () => {
    await expect(
      signInWithGoogle(googleProfile({ email: 'stranger@gmail.com' }), OPTIONS),
    ).rejects.toMatchObject({ status: 403 });
    expect(await User.countDocuments()).toBe(1); // nobody was created
  });

  it('refuses a deactivated user', async () => {
    await User.updateOne({ email: 'boss@engenx.in' }, { $set: { status: 'deactivated' } });
    await expect(signInWithGoogle(googleProfile(), OPTIONS)).rejects.toMatchObject({ status: 403 });
  });

  it('refuses an unverified email address', async () => {
    await expect(
      signInWithGoogle(googleProfile({ emailVerified: false }), OPTIONS),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('refuses a different Google account using the email of an existing user', async () => {
    await signInWithGoogle(googleProfile(), OPTIONS);
    await expect(
      signInWithGoogle(googleProfile({ googleId: 'someone-else' }), OPTIONS),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('gives the same message for "not invited" and "deactivated"', async () => {
    const notInvited = await signInWithGoogle(
      googleProfile({ email: 'x@gmail.com' }),
      OPTIONS,
    ).catch((error) => error.message);
    await User.updateOne({ email: 'boss@engenx.in' }, { $set: { status: 'deactivated' } });
    const deactivated = await signInWithGoogle(googleProfile(), OPTIONS).catch(
      (error) => error.message,
    );
    expect(notInvited).toBe(deactivated);
  });

  it('lets an invited normal Gmail account sign in, marked as not a Workspace account', async () => {
    await inviteUser('agent@gmail.com', 'Sales Agent');
    const { userId } = await signInWithGoogle(
      googleProfile({ googleId: 'g-2', email: 'agent@gmail.com' }),
      OPTIONS,
    );
    const user = await User.findById(userId);
    expect(user.status).toBe('active');
    expect(user.isWorkspaceAccount).toBe(false);
  });
});

describe('loadRequestUser', () => {
  it('returns the role grants and the ids of direct reports', async () => {
    const manager = await inviteUser('mgr@engenx.in', 'Sales Manager', { status: 'active' });
    const agent = await inviteUser('a1@engenx.in', 'Sales Agent', {
      status: 'active',
      managerId: manager._id,
    });
    await inviteUser('a2@engenx.in', 'Sales Agent', {
      status: 'deactivated',
      managerId: manager._id,
    });

    const loaded = await loadRequestUser(manager._id);
    expect(loaded.role.name).toBe('Sales Manager');
    expect(loaded.role.grants.length).toBeGreaterThan(0);
    expect(loaded.teamUserIds.map(String)).toEqual([String(agent._id)]);
  });

  it('returns null for an invited or deactivated user', async () => {
    const invited = await inviteUser('new@engenx.in', 'Sales Agent');
    expect(await loadRequestUser(invited._id)).toBeNull();
  });
});

describe('auth endpoints', () => {
  // The real app with an in-memory session store, plus one test-only route that signs a user in
  // the same way the Google callback does (by putting the user id into the session).
  function makeApp() {
    const sessionMiddleware = session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
    });
    const app = createApp({
      sessionMiddleware: [
        sessionMiddleware,
        (req, res, next) => {
          if (req.path !== '/__test/sign-in') return next();
          req.session.userId = req.query.userId;
          return req.session.save(() => res.json({ ok: true }));
        },
      ],
    });
    return app;
  }

  it('GET /api/auth/me without a session is 401', async () => {
    const response = await request(makeApp()).get('/api/auth/me');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });

  it('GET /api/auth/me returns the user and grants, and nothing secret', async () => {
    const { userId } = await signInWithGoogle(
      { googleId: 'g-1', email: 'boss@engenx.in', emailVerified: true, name: 'The Boss' },
      OPTIONS,
    );
    const agent = request.agent(makeApp());
    await agent.get(`/__test/sign-in?userId=${userId}`);

    const response = await agent.get('/api/auth/me');
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      email: 'boss@engenx.in',
      name: 'The Boss',
      role: { name: 'CEO' },
    });
    expect(response.body.data.grants.length).toBeGreaterThan(0);
    expect(JSON.stringify(response.body)).not.toMatch(/googleId|teamUserIds/);
  });

  it('a user deactivated after signing in is signed out on the next request', async () => {
    const { userId } = await signInWithGoogle(
      { googleId: 'g-1', email: 'boss@engenx.in', emailVerified: true },
      OPTIONS,
    );
    const agent = request.agent(makeApp());
    await agent.get(`/__test/sign-in?userId=${userId}`);
    expect((await agent.get('/api/auth/me')).status).toBe(200);

    await User.updateOne({ _id: userId }, { $set: { status: 'deactivated' } });
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('POST /api/auth/logout ends the session', async () => {
    const { userId } = await signInWithGoogle(
      { googleId: 'g-1', email: 'boss@engenx.in', emailVerified: true },
      OPTIONS,
    );
    const agent = request.agent(makeApp());
    await agent.get(`/__test/sign-in?userId=${userId}`);

    expect((await agent.post('/api/auth/logout')).status).toBe(200);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });
});
