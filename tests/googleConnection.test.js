import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// The settings exist only for this test file. Google itself is replaced: `fetch` answers the
// token and revoke addresses from `google`, and collects what was sent.
Object.assign(process.env, {
  GOOGLE_WORKSPACE_CLIENT_ID: 'workspace-client-id',
  GOOGLE_WORKSPACE_CLIENT_SECRET: 'workspace-client-secret',
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
});

const sent = [];
const google = {
  refresh: { status: 200, body: { access_token: 'fresh-access', expires_in: 3600 } },
};
vi.stubGlobal('fetch', async (url, options) => {
  const fields = Object.fromEntries(new URLSearchParams(options.body));
  sent.push({ url: String(url), fields });
  if (String(url).endsWith('/revoke')) return new Response('{}', { status: 200 });
  return new Response(JSON.stringify(google.refresh.body), { status: google.refresh.status });
});

const { createApp } = await import('../app.js');
const { createSessionMiddleware } = await import('../middleware/session.js');
const { AuditLog } = await import('../models/auditLog.model.js');
const { Role } = await import('../models/role.model.js');
const { User } = await import('../models/user.model.js');
const { UserGoogleConnection } = await import('../models/userGoogleConnection.model.js');
const { runSeed } = await import('../seeds/seed.js');
const { loadRequestUser } = await import('../services/auth.service.js');
const { completeConnect, getGoogleAccessToken } =
  await import('../services/googleConnection.service.js');
const { clearTestDb, startTestDb, stopTestDb } = await import('./helpers/testDb.js');

const PASSWORD = 'correct-horse-battery';
const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.events',
];
let app;
let boss; // kunal@engenx.in, the CEO: manages the settings
let asha; // asha@engenx.in: a Sales Agent with a company address
let outsider; // a normal Gmail user of the CRM
let asBoss;
let asAsha;
let asOutsider;

// The company mailbox (decision 0014).
const grant = (extra = {}) => ({
  accessToken: 'first-access-token',
  refreshToken: 'the-refresh-token',
  expiresInSec: 3600,
  scopes: SCOPES,
  googleEmail: 'kunal@engenx.in',
  hostedDomain: 'engenx.in',
  ...extra,
});
const revoked = () =>
  sent.filter((item) => item.url.endsWith('/revoke')).map((item) => item.fields.token);

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
  sent.length = 0;
  google.refresh = { status: 200, body: { access_token: 'fresh-access', expires_in: 3600 } };
  await runSeed({ productName: 'P', companyName: 'C', workspaceDomain: 'engenx.in' });
  const roles = Object.fromEntries((await Role.find()).map((role) => [role.name, role]));
  const makeUser = (email, roleName, isWorkspaceAccount) =>
    User.create({
      email,
      name: email,
      roleId: roles[roleName]._id,
      status: 'active',
      password: PASSWORD,
      isWorkspaceAccount,
    });
  const made = await Promise.all([
    makeUser('kunal@engenx.in', 'CEO', true),
    makeUser('asha@engenx.in', 'Sales Agent', true),
    makeUser('someone@gmail.com', 'Sales Agent', false),
  ]);
  [asBoss, asAsha, asOutsider] = await Promise.all(made.map(signedInAs));
  [boss, asha, outsider] = await Promise.all(made.map((user) => loadRequestUser(user._id)));
  await AuditLog.deleteMany({});
});

describe('who may connect the company mailbox', () => {
  it('someone who manages the settings is sent to Google; nobody else is', async () => {
    const status = (await asBoss.get('/api/integrations/google')).body.data;
    expect(status).toEqual({
      isConfigured: true,
      missing: [],
      workspaceDomain: 'engenx.in',
      mayConnect: true,
      connection: null,
    });
    expect((await asAsha.get('/api/integrations/google')).body.data.mayConnect).toBe(false);
    expect((await asOutsider.get('/api/integrations/google')).body.data.mayConnect).toBe(false);

    const start = await asBoss.get('/api/integrations/google/connect');
    expect(start.status).toBe(302);
    const target = new URL(start.headers.location);
    expect(target.origin + target.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(target.searchParams)).toMatchObject({
      client_id: 'workspace-client-id',
      redirect_uri: 'http://localhost:5173/api/integrations/google/callback',
      access_type: 'offline',
      prompt: 'consent',
      hd: 'engenx.in',
      response_type: 'code',
    });
    expect(target.searchParams.get('scope').split(' ')).toEqual(SCOPES);
    expect(target.searchParams.get('state')).toBeTruthy();

    // An agent (even with a company address) and a normal Gmail user: by the screen, and in
    // the service.
    for (const [client, actor] of [
      [asAsha, asha],
      [asOutsider, outsider],
    ]) {
      const refused = await client.get('/api/integrations/google/connect');
      expect(refused.headers.location).toBe('http://localhost:5173/connections?google=not_allowed');
      await expect(completeConnect(actor, grant())).rejects.toMatchObject({ status: 403 });
    }
    expect(await UserGoogleConnection.countDocuments()).toBe(0);
    expect((await request(app).get('/api/integrations/google/connect')).status).toBe(401);
  });

  it('a return from Google that we did not start, or that was cancelled, connects nothing', async () => {
    const forged = await asBoss.get('/api/integrations/google/callback?code=abc&state=made-up');
    expect(forged.headers.location).toBe('http://localhost:5173/connections?google=failed');
    const cancelled = await asBoss.get('/api/integrations/google/callback?error=access_denied');
    expect(cancelled.headers.location).toBe('http://localhost:5173/connections?google=cancelled');
    expect(await UserGoogleConnection.countDocuments()).toBe(0);
  });

  it('only a company address, with both permissions; a refused permission is given back', async () => {
    const cases = [
      [{ googleEmail: 'kunal@gmail.com', hostedDomain: null }, 'GOOGLE_WRONG_DOMAIN'],
      [
        { scopes: SCOPES.filter((scope) => !scope.includes('calendar')) },
        'GOOGLE_PERMISSION_MISSING',
      ],
      [{ googleEmail: null }, 'GOOGLE_WRONG_DOMAIN'],
    ];
    for (const [extra, code] of cases) {
      await expect(completeConnect(boss, grant(extra)), code).rejects.toMatchObject({
        code,
        status: 403,
      });
    }
    expect(revoked()).toEqual(Array(3).fill('the-refresh-token'));
    expect(await UserGoogleConnection.countDocuments()).toBe(0);
    // Google sent no lasting permission: nothing to keep.
    await expect(completeConnect(boss, grant({ refreshToken: undefined }))).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe('the company mailbox', () => {
  it('keeps the tokens sealed and out of every answer; everyone sees which mailbox it is', async () => {
    await completeConnect(boss, grant());
    const raw = await UserGoogleConnection.findOne().select('+refreshToken +accessToken').lean();
    expect(raw.refreshToken.startsWith('v1.')).toBe(true);
    expect(JSON.stringify(raw)).not.toContain('the-refresh-token');
    expect(JSON.stringify(raw)).not.toContain('first-access-token');
    // A normal read does not even carry the sealed form.
    expect((await UserGoogleConnection.findOne().lean()).refreshToken).toBeUndefined();

    for (const client of [asBoss, asAsha, asOutsider]) {
      const response = await client.get('/api/integrations/google');
      expect(response.body.data.connection).toMatchObject({
        googleEmail: 'kunal@engenx.in',
        status: 'connected',
        connectedBy: 'kunal@engenx.in',
        hasMail: true,
        hasCalendar: true,
        lastError: null,
      });
      expect(response.text).not.toMatch(/token/i);
    }
    const audit = await AuditLog.find({ action: 'google.connected' }).lean();
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toMatch(/token/i);
    // The next time Google's screen offers the connected mailbox.
    const start = await asBoss.get('/api/integrations/google/connect');
    expect(new URL(start.headers.location).searchParams.get('login_hint')).toBe('kunal@engenx.in');
  });

  it('there is one: the same mailbox again goes on where it stood; another one replaces it', async () => {
    await completeConnect(boss, grant());
    const first = await UserGoogleConnection.findOne().lean();
    await UserGoogleConnection.updateOne({}, { $set: { 'gmail.historyId': '555' } });

    await completeConnect(boss, grant({ refreshToken: 'second-refresh-token' }));
    const again = await UserGoogleConnection.find().lean();
    expect(again).toHaveLength(1);
    expect(String(again[0]._id)).toBe(String(first._id));
    expect(again[0].gmail.historyId).toBe('555');
    expect(revoked()).toEqual([]);

    await completeConnect(boss, grant({ googleEmail: 'sales@engenx.in' }));
    const replaced = await UserGoogleConnection.find().lean();
    expect(replaced.map((item) => item.googleEmail)).toEqual(['sales@engenx.in']);
    expect(replaced[0].gmail?.historyId).toBeUndefined();
    expect(revoked()).toEqual(['second-refresh-token']); // the mailbox before is let go
  });

  it('hands out a working access token: the kept one, a fresh one when it ran out', async () => {
    await expect(getGoogleAccessToken()).rejects.toMatchObject({ code: 'GOOGLE_NOT_CONNECTED' });
    await completeConnect(boss, grant());
    expect(await getGoogleAccessToken()).toBe('first-access-token');
    expect(sent).toHaveLength(0);

    await UserGoogleConnection.updateOne(
      {},
      { $set: { accessTokenExpiresAt: new Date(Date.now() - 1000) } },
    );
    expect(await getGoogleAccessToken()).toBe('fresh-access');
    expect(sent[0]).toMatchObject({
      url: 'https://oauth2.googleapis.com/token',
      fields: {
        grant_type: 'refresh_token',
        refresh_token: 'the-refresh-token',
        client_id: 'workspace-client-id',
      },
    });
    expect(await getGoogleAccessToken()).toBe('fresh-access'); // kept again
    expect(sent).toHaveLength(1);
  });

  it('is marked "connect again" when Google takes the permission away', async () => {
    await completeConnect(boss, grant({ expiresInSec: -10 }));
    google.refresh = { status: 400, body: { error: 'invalid_grant' } };
    await expect(getGoogleAccessToken()).rejects.toMatchObject({
      code: 'GOOGLE_ACCESS_REVOKED',
    });
    const shown = (await asAsha.get('/api/integrations/google')).body.data.connection;
    expect(shown).toMatchObject({
      status: 'needs_reconnect',
      lastError: 'Google no longer allows access to this mailbox. Connect it again.',
    });
    await expect(getGoogleAccessToken()).rejects.toMatchObject({
      code: 'GOOGLE_NOT_CONNECTED',
    });
    // A Google outage is not the same thing: the connection stays.
    await completeConnect(boss, grant({ expiresInSec: -10 }));
    google.refresh = { status: 500, body: {} };
    await expect(getGoogleAccessToken()).rejects.toMatchObject({ code: 'GOOGLE_ERROR' });
    expect((await UserGoogleConnection.findOne().lean()).status).toBe('connected');
  });

  it('only someone who manages the settings removes it; Google is told, and it is written down', async () => {
    await completeConnect(boss, grant());
    expect((await asAsha.delete('/api/integrations/google')).status).toBe(403);
    expect(await UserGoogleConnection.countDocuments()).toBe(1);

    const response = await asBoss.delete('/api/integrations/google');
    expect(response.status).toBe(200);
    expect(response.body.data.connection).toBeNull();
    expect(revoked()).toEqual(['the-refresh-token']);
    expect(await UserGoogleConnection.countDocuments()).toBe(0);
    expect(await AuditLog.countDocuments({ action: 'google.disconnected' })).toBe(1);
    // Nothing to disconnect: still a normal answer.
    expect((await asBoss.delete('/api/integrations/google')).status).toBe(200);
  });
});

describe('the move to one company mailbox (migration)', () => {
  it('keeps the working mailbox with the most mail; the others are set aside and can come back', async () => {
    const { default: mongoose } = await import('mongoose');
    const { up, down } = await import('../migrations/20261015120155-company-mailbox.js');
    const db = mongoose.connection.db;
    const row = (userId, googleEmail, status, connectedAt) => ({
      userId,
      googleEmail,
      status,
      connectedAt: new Date(connectedAt),
      refreshToken: 'v1.sealed',
      scopes: SCOPES,
    });
    await db
      .collection('user_google_connections')
      .insertMany([
        row(asha._id, 'asha@engenx.in', 'connected', '2026-10-14'),
        row(boss._id, 'kunal@engenx.in', 'connected', '2026-10-10'),
        row(outsider._id, 'old@engenx.in', 'needs_reconnect', '2026-10-15'),
      ]);
    await db.collection('email_threads').insertMany([
      { userId: boss._id, gmailThreadId: 'a' },
      { userId: boss._id, gmailThreadId: 'b' },
      { userId: asha._id, gmailThreadId: 'c' },
    ]);

    await up(db);
    const kept = await db.collection('user_google_connections').find().toArray();
    expect(kept.map((item) => [item.googleEmail, String(item.connectedBy)])).toEqual([
      ['kunal@engenx.in', String(boss._id)],
    ]);
    expect(await getGoogleAccessToken().catch((error) => error.code)).not.toBe(
      'GOOGLE_NOT_CONNECTED',
    );
    expect(await db.collection('user_google_connections_removed').countDocuments()).toBe(2);

    await down(db);
    expect(await db.collection('user_google_connections').countDocuments()).toBe(3);
    expect(await db.collection('user_google_connections_removed').countDocuments()).toBe(0);
  });
});
