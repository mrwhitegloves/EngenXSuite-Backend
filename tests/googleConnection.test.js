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
let asha; // asha@engenx.in: a company address
let outsider; // a normal Gmail user of the CRM
let asAsha;
let asOutsider;

const grant = (extra = {}) => ({
  accessToken: 'first-access-token',
  refreshToken: 'the-refresh-token',
  expiresInSec: 3600,
  scopes: SCOPES,
  googleEmail: 'asha@engenx.in',
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
  const role = await Role.findOne({ name: 'Sales Agent' });
  const makeUser = (email, isWorkspaceAccount) =>
    User.create({
      email,
      name: email,
      roleId: role._id,
      status: 'active',
      password: PASSWORD,
      isWorkspaceAccount,
    });
  const [first, second] = await Promise.all([
    makeUser('asha@engenx.in', true),
    makeUser('someone@gmail.com', false),
  ]);
  [asAsha, asOutsider] = await Promise.all([first, second].map(signedInAs));
  asha = await loadRequestUser(first._id);
  outsider = await loadRequestUser(second._id);
  await AuditLog.deleteMany({});
});

describe('who may connect Gmail and Calendar', () => {
  it('a company address is sent to Google with the right request; a normal Gmail user never is', async () => {
    const status = (await asAsha.get('/api/integrations/google')).body.data;
    expect(status).toEqual({
      isConfigured: true,
      missing: [],
      workspaceDomain: 'engenx.in',
      mayConnect: true,
      connection: null,
    });
    expect((await asOutsider.get('/api/integrations/google')).body.data.mayConnect).toBe(false);

    const start = await asAsha.get('/api/integrations/google/connect');
    expect(start.status).toBe(302);
    const target = new URL(start.headers.location);
    expect(target.origin + target.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(target.searchParams)).toMatchObject({
      client_id: 'workspace-client-id',
      redirect_uri: 'http://localhost:5173/api/integrations/google/callback',
      access_type: 'offline',
      prompt: 'consent',
      hd: 'engenx.in',
      login_hint: 'asha@engenx.in',
      response_type: 'code',
    });
    expect(target.searchParams.get('scope').split(' ')).toEqual(SCOPES);
    expect(target.searchParams.get('state')).toBeTruthy();

    // The normal Gmail user: by the screen, by the address directly, and in the service.
    const refused = await asOutsider.get('/api/integrations/google/connect');
    expect(refused.headers.location).toBe('http://localhost:5173/connections?google=not_allowed');
    await expect(
      completeConnect(outsider, grant({ googleEmail: 'someone@gmail.com' })),
    ).rejects.toMatchObject({
      status: 403,
    });
    expect(await UserGoogleConnection.countDocuments()).toBe(0);
    expect((await request(app).get('/api/integrations/google/connect')).status).toBe(401);
  });

  it('a return from Google that we did not start, or that was cancelled, connects nothing', async () => {
    const forged = await asAsha.get('/api/integrations/google/callback?code=abc&state=made-up');
    expect(forged.headers.location).toBe('http://localhost:5173/connections?google=failed');
    const cancelled = await asAsha.get('/api/integrations/google/callback?error=access_denied');
    expect(cancelled.headers.location).toBe('http://localhost:5173/connections?google=cancelled');
    expect(await UserGoogleConnection.countDocuments()).toBe(0);
  });

  it('only one’s own company mailbox, with both permissions; a refused permission is given back', async () => {
    const cases = [
      [{ googleEmail: 'asha@gmail.com', hostedDomain: null }, 'GOOGLE_WRONG_DOMAIN'],
      [{ googleEmail: 'boss@engenx.in' }, 'GOOGLE_WRONG_ACCOUNT'],
      [
        { scopes: SCOPES.filter((scope) => !scope.includes('calendar')) },
        'GOOGLE_PERMISSION_MISSING',
      ],
      [{ googleEmail: null }, 'GOOGLE_WRONG_DOMAIN'],
    ];
    for (const [extra, code] of cases) {
      await expect(completeConnect(asha, grant(extra)), code).rejects.toMatchObject({
        code,
        status: 403,
      });
    }
    expect(revoked()).toEqual(Array(4).fill('the-refresh-token'));
    expect(await UserGoogleConnection.countDocuments()).toBe(0);
    // Google sent no lasting permission: nothing to keep.
    await expect(completeConnect(asha, grant({ refreshToken: undefined }))).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe('a connection', () => {
  it('keeps the tokens sealed and out of every answer, the audit log included', async () => {
    await completeConnect(asha, grant());
    const raw = await UserGoogleConnection.findOne().select('+refreshToken +accessToken').lean();
    expect(raw.refreshToken.startsWith('v1.')).toBe(true);
    expect(JSON.stringify(raw)).not.toContain('the-refresh-token');
    expect(JSON.stringify(raw)).not.toContain('first-access-token');
    // A normal read does not even carry the sealed form.
    expect((await UserGoogleConnection.findOne().lean()).refreshToken).toBeUndefined();

    const response = await asAsha.get('/api/integrations/google');
    expect(response.body.data.connection).toMatchObject({
      googleEmail: 'asha@engenx.in',
      status: 'connected',
      hasMail: true,
      hasCalendar: true,
      lastError: null,
    });
    expect(response.text).not.toMatch(/token/i);
    const audit = await AuditLog.find({ action: 'google.connected' }).lean();
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toMatch(/token/i);
    // Each person sees only their own.
    expect((await asOutsider.get('/api/integrations/google')).body.data.connection).toBeNull();
  });

  it('hands out a working access token: the kept one, a fresh one when it ran out', async () => {
    await completeConnect(asha, grant());
    expect(await getGoogleAccessToken(asha._id)).toBe('first-access-token');
    expect(sent).toHaveLength(0);

    await UserGoogleConnection.updateOne(
      {},
      { $set: { accessTokenExpiresAt: new Date(Date.now() - 1000) } },
    );
    expect(await getGoogleAccessToken(asha._id)).toBe('fresh-access');
    expect(sent[0]).toMatchObject({
      url: 'https://oauth2.googleapis.com/token',
      fields: {
        grant_type: 'refresh_token',
        refresh_token: 'the-refresh-token',
        client_id: 'workspace-client-id',
      },
    });
    expect(await getGoogleAccessToken(asha._id)).toBe('fresh-access'); // kept again
    expect(sent).toHaveLength(1);
    await expect(getGoogleAccessToken(outsider._id)).rejects.toMatchObject({
      code: 'GOOGLE_NOT_CONNECTED',
    });
  });

  it('is marked "connect again" when Google takes the permission away', async () => {
    await completeConnect(asha, grant({ expiresInSec: -10 }));
    google.refresh = { status: 400, body: { error: 'invalid_grant' } };
    await expect(getGoogleAccessToken(asha._id)).rejects.toMatchObject({
      code: 'GOOGLE_ACCESS_REVOKED',
    });
    const shown = (await asAsha.get('/api/integrations/google')).body.data.connection;
    expect(shown).toMatchObject({
      status: 'needs_reconnect',
      lastError: 'Google no longer allows access to this mailbox. Connect it again.',
    });
    await expect(getGoogleAccessToken(asha._id)).rejects.toMatchObject({
      code: 'GOOGLE_NOT_CONNECTED',
    });
    // A Google outage is not the same thing: the connection stays.
    await completeConnect(asha, grant({ expiresInSec: -10 }));
    google.refresh = { status: 500, body: {} };
    await expect(getGoogleAccessToken(asha._id)).rejects.toMatchObject({ code: 'GOOGLE_ERROR' });
    expect((await UserGoogleConnection.findOne().lean()).status).toBe('connected');
  });

  it('disconnecting tells Google, deletes our copy, and is written down', async () => {
    await completeConnect(asha, grant());
    const response = await asAsha.delete('/api/integrations/google');
    expect(response.status).toBe(200);
    expect(response.body.data.connection).toBeNull();
    expect(revoked()).toEqual(['the-refresh-token']);
    expect(await UserGoogleConnection.countDocuments()).toBe(0);
    expect(await AuditLog.countDocuments({ action: 'google.disconnected' })).toBe(1);
    // Nothing to disconnect: still a normal answer.
    expect((await asAsha.delete('/api/integrations/google')).status).toBe(200);
  });
});
