import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { createSessionMiddleware } from '../middleware/session.js';
import { Role } from '../models/role.model.js';
import { User } from '../models/user.model.js';
import { runSeed } from '../seeds/seed.js';
import { clearTestDb, startTestDb, stopTestDb } from './helpers/testDb.js';

// The client address in tests is the default APP_URL.
const CLIENT = 'http://localhost:5173';
const PASSWORD = 'correct-horse-battery';
let app;
let ceo;
let agent;

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
  agent = await makeUser('agent@engenx.in', 'Sales Agent');
});

describe('cross-site request protection', () => {
  it('another website cannot make a signed-in browser change something', async () => {
    const browser = await signedInAs(ceo);
    const attack = (headers) =>
      browser.patch(`/api/users/${agent._id}`).set(headers).send({ status: 'deactivated' });

    for (const headers of [
      { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
      { Origin: 'https://evil.example' }, // an older browser without Sec-Fetch-Site
      { 'Sec-Fetch-Site': 'cross-site' },
      // A sister sub-domain is still another website.
      { Origin: 'https://www.engenx.in', 'Sec-Fetch-Site': 'same-site' },
      { Origin: 'null' }, // a sandboxed page
      { Origin: `${CLIENT}.evil.example` }, // looks like our address, is not
    ]) {
      const response = await attack(headers);
      expect(response.status, JSON.stringify(headers)).toBe(403);
      expect(response.body.error.code).toBe('CROSS_SITE_REQUEST');
    }
    expect((await User.findById(agent._id).lean()).status).toBe('active');
  });

  it('blocks cross-site sign-in and sign-out too', async () => {
    const evil = { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' };
    const login = await request(app)
      .post('/api/auth/login')
      .set(evil)
      .send({ email: ceo.email, password: PASSWORD });
    expect(login.status).toBe(403);

    const browser = await signedInAs(ceo);
    expect((await browser.post('/api/auth/logout').set(evil)).status).toBe(403);
    expect((await browser.get('/api/auth/me')).status).toBe(200); // still signed in
  });

  it('our own client is allowed', async () => {
    const browser = await signedInAs(ceo);
    for (const headers of [
      { Origin: CLIENT, 'Sec-Fetch-Site': 'same-origin' },
      { 'Sec-Fetch-Site': 'same-origin' },
      { Origin: CLIENT }, // an older browser
      { Origin: CLIENT, 'Sec-Fetch-Site': 'cross-site' }, // client and API on different addresses
    ]) {
      const response = await browser
        .patch(`/api/users/${agent._id}`)
        .set(headers)
        .send({ name: `Name ${Object.keys(headers).length}` });
      expect(response.status, JSON.stringify(headers)).toBe(200);
    }
  });

  it('reading is never blocked, and a caller that is not a browser page passes this check', async () => {
    const browser = await signedInAs(ceo);
    const evil = { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' };
    expect((await browser.get('/api/users').set(evil)).status).toBe(200);
    // No Origin and no Sec-Fetch-Site: not blocked here, but still needs a session.
    expect((await request(app).patch(`/api/users/${agent._id}`).send({ name: 'X' })).status).toBe(
      401,
    );
  });
});
