import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// The mailer is the one thing replaced in this file: no real email is sent, and the test reads
// the message the app would have sent. Everything else is real.
const sentMessages = [];
vi.mock('../infra/mailer.js', () => ({
  isMailConfigured: () => true,
  sendMail: async (message) => {
    sentMessages.push(message);
    return { sent: true };
  },
}));

const { createApp } = await import('../app.js');
const { createSessionMiddleware } = await import('../middleware/session.js');
const { AuditLog } = await import('../models/auditLog.model.js');
const { PasswordReset } = await import('../models/passwordReset.model.js');
const { Role } = await import('../models/role.model.js');
const { User } = await import('../models/user.model.js');
const { buildPasswordFields } = await import('../infra/password.js');
const { runSeed } = await import('../seeds/seed.js');
const { clearTestDb, startTestDb, stopTestDb } = await import('./helpers/testDb.js');

const OLD_PASSWORD = 'the-old-password-1';
const NEW_PASSWORD = 'a-brand-new-password-2';
let app;
let user;

const tokenFromLastEmail = () => sentMessages.at(-1).text.match(/token=([\w-]+)/)[1];
const login = (password) =>
  request(app).post('/api/auth/login').send({ email: user.email, password });

beforeAll(async () => {
  await startTestDb();
  app = createApp({ sessionMiddleware: createSessionMiddleware() });
});
afterAll(stopTestDb);

beforeEach(async () => {
  sentMessages.length = 0;
  await clearTestDb();
  await runSeed({ productName: 'TestProduct', companyName: 'C', workspaceDomain: 'engenx.in' });
  const role = await Role.findOne({ name: 'Sales Agent' });
  user = await User.create({
    email: 'agent@engenx.in',
    name: 'Agent One',
    roleId: role._id,
    status: 'active',
    ...(await buildPasswordFields(OLD_PASSWORD)),
  });
});

describe('forgot password', () => {
  it('answers the same for a known and an unknown email, and emails only the known one', async () => {
    const known = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'Agent@Engenx.in' });
    const unknown = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'nobody@example.com' });

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual(known.body);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].to).toBe('agent@engenx.in');
    // The product name comes from the settings record, not from the code.
    expect(sentMessages[0].subject).toContain('TestProduct');
  });

  it('stores only a hash of the token, never the token itself', async () => {
    await request(app).post('/api/auth/forgot-password').send({ email: user.email });
    const token = tokenFromLastEmail();
    const stored = await PasswordReset.findOne({ userId: user._id }).lean();
    expect(stored.tokenHash).not.toBe(token);
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('sends nothing to a deactivated user', async () => {
    await User.updateOne({ _id: user._id }, { $set: { status: 'deactivated' } });
    const response = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: user.email });
    expect(response.status).toBe(200);
    expect(sentMessages).toHaveLength(0);
  });

  it('the link sets a new password, ends the sessions, and works only once', async () => {
    const browser = request.agent(app);
    await browser.post('/api/auth/login').send({ email: user.email, password: OLD_PASSWORD });
    expect((await browser.get('/api/auth/me')).status).toBe(200);

    await request(app).post('/api/auth/forgot-password').send({ email: user.email });
    const token = tokenFromLastEmail();

    const reset = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, newPassword: NEW_PASSWORD });
    expect(reset.status).toBe(200);

    expect((await browser.get('/api/auth/me')).status).toBe(401); // signed out everywhere
    expect((await login(OLD_PASSWORD)).status).toBe(401);
    const signedIn = await login(NEW_PASSWORD);
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.data.mustChangePassword).toBe(false);

    const again = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'yet-another-password-3' });
    expect(again.status).toBe(400);
    expect((await login(NEW_PASSWORD)).status).toBe(200);

    const audit = await AuditLog.find({ action: 'user.password_reset_by_email' }).lean();
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(NEW_PASSWORD);
  });

  it('refuses an expired link, a made-up token and a weak new password', async () => {
    await request(app).post('/api/auth/forgot-password').send({ email: user.email });
    const token = tokenFromLastEmail();

    const weak = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'short' });
    expect(weak.status).toBe(400);

    const madeUp = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: 'x'.repeat(43), newPassword: NEW_PASSWORD });
    expect(madeUp.status).toBe(400);

    await PasswordReset.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, newPassword: NEW_PASSWORD });
    expect(expired.status).toBe(400);
    expect((await login(OLD_PASSWORD)).status).toBe(200); // nothing changed
  });

  it('only the newest link works', async () => {
    await request(app).post('/api/auth/forgot-password').send({ email: user.email });
    const firstToken = tokenFromLastEmail();
    await request(app).post('/api/auth/forgot-password').send({ email: user.email });
    const secondToken = tokenFromLastEmail();

    const withFirst = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: firstToken, newPassword: NEW_PASSWORD });
    expect(withFirst.status).toBe(400);
    const withSecond = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: secondToken, newPassword: NEW_PASSWORD });
    expect(withSecond.status).toBe(200);
  });
});
