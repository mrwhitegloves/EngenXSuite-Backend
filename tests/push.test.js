import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// The push services of the browsers are replaced: what would be sent is collected here, and
// an endpoint that contains "expired" answers like a subscription that is gone.
const sent = [];
vi.mock('../infra/push.js', () => ({
  isPushConfigured: () => true,
  pushPublicKey: () => 'test-public-key',
  sendPush: async (subscription, message) => {
    if (subscription.endpoint.includes('expired')) return 'gone';
    if (subscription.endpoint.includes('broken')) return 'failed';
    sent.push({ endpoint: subscription.endpoint, message });
    return 'sent';
  },
}));

const { createApp } = await import('../app.js');
const { createSessionMiddleware } = await import('../middleware/session.js');
const { PushSubscription } = await import('../models/pushSubscription.model.js');
const { Role } = await import('../models/role.model.js');
const { User } = await import('../models/user.model.js');
const { runSeed } = await import('../seeds/seed.js');
const { notify, pushToUser } = await import('../services/notifications.service.js');
const { clearTestDb, startTestDb, stopTestDb } = await import('./helpers/testDb.js');

const PASSWORD = 'correct-horse-battery';
const KEYS = { p256dh: 'p256dh-key', auth: 'auth-key' };
const endpoint = (name) => `https://push.example.com/send/${name}`;
let app;
let ceo;
let agent;
let asCeo;
let asAgent;

async function signedInAs(user) {
  const client = request.agent(app);
  const response = await client
    .post('/api/auth/login')
    .send({ email: user.email, password: PASSWORD });
  expect(response.status).toBe(200);
  return client;
}

const subscribe = (client, name) =>
  client
    .post('/api/notifications/push/subscribe')
    .set('User-Agent', 'Test Browser')
    .send({ endpoint: endpoint(name), keys: KEYS });

/** Wait until the push that notify() starts on the side has been handed over. */
async function untilSent(count) {
  for (let attempt = 0; attempt < 100 && sent.length < count; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeAll(async () => {
  await startTestDb();
  app = createApp({ sessionMiddleware: createSessionMiddleware() });
});
afterAll(stopTestDb);

beforeEach(async () => {
  await clearTestDb();
  sent.length = 0;
  await runSeed({ productName: 'P', companyName: 'C', workspaceDomain: 'engenx.in' });
  const roles = Object.fromEntries((await Role.find()).map((role) => [role.name, role]));
  const makeUser = (email, name, roleName) =>
    User.create({ email, name, roleId: roles[roleName]._id, status: 'active', password: PASSWORD });
  ceo = await makeUser('ceo@engenx.in', 'Kunal CEO', 'CEO');
  agent = await makeUser('agent@engenx.in', 'Asha Agent', 'Sales Agent');
  [asCeo, asAgent] = await Promise.all([ceo, agent].map(signedInAs));
});

describe('browser push', () => {
  it('the browser app is given the public key, and a signed-in person subscribes a browser', async () => {
    expect((await request(app).get('/api/public/config')).body.data.pushPublicKey).toBe(
      'test-public-key',
    );

    expect((await subscribe(asAgent, 'laptop')).body.data).toEqual({ subscribed: true });
    await subscribe(asAgent, 'phone');
    // The same browser again: still one subscription for it.
    await subscribe(asAgent, 'laptop');
    const saved = await PushSubscription.find().sort({ endpoint: 1 }).lean();
    expect(saved.map((item) => [item.endpoint, String(item.userId), item.userAgent])).toEqual([
      [endpoint('laptop'), String(agent._id), 'Test Browser'],
      [endpoint('phone'), String(agent._id), 'Test Browser'],
    ]);

    expect((await subscribe(request(app), 'x')).status).toBe(401);
    const bad = await asAgent
      .post('/api/notifications/push/subscribe')
      .send({ endpoint: 'not-a-url', keys: KEYS });
    expect(bad.status).toBe(400);
    expect(
      (await asAgent.post('/api/notifications/push/subscribe').send({ endpoint: endpoint('y') }))
        .status,
    ).toBe(400);
  });

  it('a notification is pushed to every browser of that person, and to nobody else', async () => {
    await subscribe(asAgent, 'laptop');
    await subscribe(asAgent, 'phone');
    await subscribe(asCeo, 'ceo-laptop');

    // The CEO gives the agent a task: the usual notification, and a push with the same words.
    const response = await asCeo
      .post('/api/tasks')
      .send({ title: 'Call the plant head', assigneeId: String(agent._id) });
    expect(response.status).toBe(201);
    await untilSent(2);
    expect(sent.map((item) => item.endpoint).sort()).toEqual([
      endpoint('laptop'),
      endpoint('phone'),
    ]);
    expect(sent[0].message).toEqual({
      title: 'Kunal CEO gave you a task',
      body: 'Call the plant head',
      link: '/activities',
    });
    const used = await PushSubscription.findOne({ endpoint: endpoint('laptop') }).lean();
    expect(used.lastUsedAt).toBeInstanceOf(Date);
  });

  it('a subscription that is gone is removed, and nothing fails because of it', async () => {
    await subscribe(asAgent, 'laptop');
    await subscribe(asAgent, 'expired-phone');
    await subscribe(asAgent, 'broken-tablet');

    expect(await pushToUser(agent._id, { title: 'Hello' })).toEqual({ sent: 1, removed: 1 });
    const left = (await PushSubscription.find().lean()).map((item) => item.endpoint).sort();
    // The expired one is gone; the one that only failed this time stays for the next try.
    expect(left).toEqual([endpoint('broken-tablet'), endpoint('laptop')]);

    // The action that notifies still succeeds when every browser is gone.
    await PushSubscription.deleteMany({});
    await subscribe(asAgent, 'expired-only');
    const response = await asCeo
      .post('/api/tasks')
      .send({ title: 'Still works', assigneeId: String(agent._id) });
    expect(response.status).toBe(201);
  });

  it('nothing is pushed with notifications switched off; a browser belongs to one person', async () => {
    await subscribe(asAgent, 'shared-laptop');
    await asAgent.patch('/api/notifications/preferences').send({ enabled: false });
    expect(
      await notify({ userId: agent._id, type: 'task_overdue', title: 'While off' }),
    ).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toEqual([]);

    // The CEO signs in on that same browser: it is the CEO's now, not the agent's.
    await subscribe(asCeo, 'shared-laptop');
    const saved = await PushSubscription.find().lean();
    expect(saved).toHaveLength(1);
    expect(String(saved[0].userId)).toBe(String(ceo._id));

    // Only the owner of a subscription can remove it.
    await asAgent
      .post('/api/notifications/push/unsubscribe')
      .send({ endpoint: endpoint('shared-laptop') });
    expect(await PushSubscription.countDocuments()).toBe(1);
    const removed = await asCeo
      .post('/api/notifications/push/unsubscribe')
      .send({ endpoint: endpoint('shared-laptop') });
    expect(removed.body.data).toEqual({ subscribed: false });
    expect(await PushSubscription.countDocuments()).toBe(0);
  });
});
