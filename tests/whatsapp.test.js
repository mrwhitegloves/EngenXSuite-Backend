import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// WhatsApp: what comes in through Meta's webhook, who sees it, and answering inside the
// 24-hour window. Meta is replaced by `fetch` below.
const APP_SECRET = 'whatsapp-app-secret';
Object.assign(process.env, {
  WHATSAPP_PHONE_NUMBER_ID: '111222333',
  WHATSAPP_ACCESS_TOKEN: 'whatsapp-token',
  WHATSAPP_VERIFY_TOKEN: 'verify-me-verify-me',
  WHATSAPP_APP_SECRET: APP_SECRET,
});

const meta = { sent: [], failWith: null };
vi.stubGlobal('fetch', async (input, options = {}) => {
  const url = String(input);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  if (!url.startsWith('https://graph.facebook.com/')) return json({});
  if (meta.failWith) return json({ error: meta.failWith }, 400);
  meta.sent.push({ url, body: JSON.parse(options.body), auth: options.headers.Authorization });
  return json({ messages: [{ id: `wamid.out${meta.sent.length}` }] });
});

const { createApp } = await import('../app.js');
const { createSessionMiddleware } = await import('../middleware/session.js');
const { Activity } = await import('../models/activity.model.js');
const { Notification } = await import('../models/notification.model.js');
const { Role } = await import('../models/role.model.js');
const { User } = await import('../models/user.model.js');
const { WebhookEvent } = await import('../models/webhookEvent.model.js');
const { WhatsAppConversation, WhatsAppMessage } = await import('../models/whatsapp.model.js');
const { runSeed, seedStartingLists, seedStatusLists } = await import('../seeds/seed.js');
const { processWebhookEvent } = await import('../services/webhooks.service.js');
const { clearTestDb, startTestDbWithTransactions, stopTestDb } =
  await import('./helpers/testDb.js');

const PASSWORD = 'correct-horse-battery';
const CUSTOMER = '919876543210';
const STRANGER = '919000011111';
let app;
let asAsha;
let asOmar;
let asCeo;
let ashaId;
let omarId;
let counter = 0;

const sign = (text) => `sha256=${createHmac('sha256', APP_SECRET).update(text).digest('hex')}`;
const postWebhook = (value, signature) => {
  const text = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba', changes: [{ field: 'messages', value }] }],
  });
  return request(app)
    .post('/api/webhooks/meta/whatsapp')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signature ?? sign(text))
    .send(text);
};
/** Deliver a webhook like Meta does, then run the background job for the stored event. */
async function deliver(value) {
  const response = await postWebhook(value);
  expect(response.status).toBe(200);
  const event = await WebhookEvent.findOne({ provider: 'whatsapp' }).sort({ _id: -1 }).lean();
  return processWebhookEvent(event._id);
}
const incoming = (from, text, extra = {}) => {
  counter += 1;
  return {
    contacts: [{ wa_id: from, profile: { name: 'Rajesh on WhatsApp' } }],
    messages: [
      {
        id: `wamid.in${counter}`,
        from,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'text',
        text: { body: text },
        ...extra,
      },
    ],
  };
};
const conversationsOf = async (client, query = '') =>
  (await client.get(`/api/whatsapp/conversations${query}`)).body.data;

async function signedInAs(user) {
  const client = request.agent(app);
  const response = await client
    .post('/api/auth/login')
    .send({ email: user.email, password: PASSWORD });
  expect(response.status).toBe(200);
  return client;
}

beforeAll(async () => {
  await startTestDbWithTransactions(); // creating a lead uses a transaction
  app = createApp({ sessionMiddleware: createSessionMiddleware() });
});
afterAll(stopTestDb);

beforeEach(async () => {
  await clearTestDb();
  Object.assign(meta, { sent: [], failWith: null });
  await runSeed({ productName: 'P', companyName: 'C', workspaceDomain: 'engenx.in' });
  await seedStatusLists();
  await seedStartingLists();
  const roles = Object.fromEntries((await Role.find()).map((role) => [role.name, role]));
  const makeUser = (email, name, roleName) =>
    User.create({ email, name, roleId: roles[roleName]._id, status: 'active', password: PASSWORD });
  const [asha, omar, ceo] = await Promise.all([
    makeUser('asha@engenx.in', 'Asha Agent', 'Sales Agent'),
    makeUser('omar@engenx.in', 'Omar Agent', 'Sales Agent'),
    makeUser('ceo@engenx.in', 'Kunal CEO', 'CEO'),
  ]);
  ashaId = String(asha._id);
  omarId = String(omar._id);
  [asAsha, asOmar, asCeo] = await Promise.all([asha, omar, ceo].map(signedInAs));
  await asAsha.post('/api/accounts/quick-add').send({
    account: { name: 'Shakti Castings' },
    contacts: [{ name: 'Rajesh Patil', phone_number: '+919876543210' }],
    lead: { name: 'Furnace energy monitoring' },
  });
});

describe('the webhook', () => {
  it('answers Meta’s one-time check only with the right token', async () => {
    const check = (token) =>
      request(app).get(
        `/api/webhooks/meta/whatsapp?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=12345`,
      );
    const right = await check('verify-me-verify-me');
    expect(right.status).toBe(200);
    expect(right.text).toBe('12345');
    expect((await check('something-else')).status).toBe(403);
  });

  it('refuses a body that Meta did not sign', async () => {
    const response = await postWebhook(incoming(CUSTOMER, 'Hello'), 'sha256=00');
    expect(response.status).toBe(401);
    expect(await WhatsAppConversation.countDocuments()).toBe(0);
  });
});

describe('a message from a customer', () => {
  it('is linked to the contact, shown to their owner, on the timeline, and stored once', async () => {
    const value = incoming(CUSTOMER, 'What would a pilot cost?');
    await deliver(value);
    await deliver(value); // Meta sends it again

    expect(await WhatsAppMessage.countDocuments()).toBe(1);
    const [row] = await conversationsOf(asAsha);
    expect(row).toMatchObject({
      phone: '+919876543210',
      name: 'Rajesh Patil',
      contact: { name: 'Rajesh Patil' },
      account: { name: 'Shakti Castings' },
      lead: { name: 'Furnace energy monitoring' },
      assignedTo: { name: 'Asha Agent' },
      snippet: 'What would a pilot cost?',
      unreadCount: 1,
      isWindowOpen: true,
    });
    const entries = await Activity.find({ type: 'WHATSAPP' }).lean();
    expect(entries.map((entry) => entry.title)).toEqual(['WhatsApp from Rajesh Patil']);
    const told = await Notification.find({ type: 'whatsapp_received' }).lean();
    expect(told.map((item) => [String(item.userId), item.title])).toEqual([
      [ashaId, 'WhatsApp from Rajesh Patil'],
    ]);

    // Opening it marks it as read.
    const open = (await asAsha.get(`/api/whatsapp/conversations/${row.id}`)).body.data;
    expect(open.messages).toMatchObject([
      { direction: 'inbound', type: 'text', text: 'What would a pilot cost?', status: 'received' },
    ]);
    expect((await conversationsOf(asAsha))[0].unreadCount).toBe(0);
    expect(await conversationsOf(asAsha, '?view=unread')).toHaveLength(0);

    // The CEO sees it; another agent does not.
    expect(await conversationsOf(asCeo)).toHaveLength(1);
    expect(await conversationsOf(asOmar)).toHaveLength(0);
    expect((await asOmar.get(`/api/whatsapp/conversations/${row.id}`)).status).toBe(404);
  });

  it('from an unknown number is a conversation without a contact, for the manager line', async () => {
    await deliver(
      incoming(STRANGER, '', { type: 'image', image: { id: 'media1', caption: 'Our furnace' } }),
    );
    const [row] = await conversationsOf(asCeo);
    expect(row).toMatchObject({
      phone: '+919000011111',
      name: 'Rajesh on WhatsApp',
      contact: null,
      account: null,
      assignedTo: null,
    });
    expect(await conversationsOf(asAsha)).toHaveLength(0); // an agent sees only their own
    const open = (await asCeo.get(`/api/whatsapp/conversations/${row.id}`)).body.data;
    expect(open.messages).toMatchObject([{ type: 'image', text: 'Our furnace' }]);
    expect(await Activity.countDocuments({ type: 'WHATSAPP' })).toBe(0);

    // Given to Omar, it is his.
    const assign = (client, assignedTo) =>
      client.patch(`/api/whatsapp/conversations/${row.id}/assign`).send({ assignedTo });
    expect((await assign(asCeo, omarId)).status).toBe(200);
    expect(await conversationsOf(asOmar, '?view=mine')).toHaveLength(1);
    expect((await assign(asAsha, ashaId)).status).toBe(404); // not hers to see
  });
});

describe('answering', () => {
  it('a text goes out inside the 24 hours, is kept, and its status moves forward only', async () => {
    await deliver(incoming(CUSTOMER, 'What would a pilot cost?'));
    const [row] = await conversationsOf(asAsha);
    const send = (client, text) =>
      client.post(`/api/whatsapp/conversations/${row.id}/messages`).send({ text });

    const sent = await send(asAsha, 'We will send the offer today.');
    expect(sent.status).toBe(200);
    expect(meta.sent[0]).toMatchObject({
      url: 'https://graph.facebook.com/v21.0/111222333/messages',
      auth: 'Bearer whatsapp-token',
      body: { to: CUSTOMER, type: 'text', text: { body: 'We will send the offer today.' } },
    });
    expect(sent.body.data.messages.at(-1)).toMatchObject({
      direction: 'outbound',
      status: 'sent',
      sentBy: 'Asha Agent',
    });
    expect(
      (await Activity.find({ type: 'WHATSAPP' }).sort({ _id: 1 }).lean()).map((e) => e.title),
    ).toEqual(['WhatsApp from Rajesh Patil', 'WhatsApp to Rajesh Patil']);

    const status = (name) => ({ statuses: [{ id: 'wamid.out1', status: name, timestamp: '1' }] });
    await deliver(status('read'));
    await deliver(status('delivered')); // arrives late: it does not move back
    expect((await WhatsAppMessage.findOne({ wamid: 'wamid.out1' }).lean()).status).toBe('read');

    expect((await send(asAsha, ' ')).status).toBe(400);
    expect((await send(asOmar, 'Hi')).status).toBe(404);
  });

  it('is refused by the server once the customer’s last message is older than 24 hours', async () => {
    await deliver(incoming(CUSTOMER, 'Hello'));
    const [row] = await conversationsOf(asAsha);
    await WhatsAppConversation.updateOne(
      { _id: row.id },
      { $set: { lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000) } },
    );
    expect((await conversationsOf(asAsha))[0].isWindowOpen).toBe(false);
    const late = await asAsha
      .post(`/api/whatsapp/conversations/${row.id}/messages`)
      .send({ text: 'Are you still interested?' });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('WHATSAPP_WINDOW_CLOSED');
    expect(meta.sent).toHaveLength(0);
  });

  it('a message Meta refuses is kept as failed, with the reason', async () => {
    await deliver(incoming(CUSTOMER, 'Hello'));
    const [row] = await conversationsOf(asAsha);
    meta.failWith = { message: 'Recipient is not a valid WhatsApp user', code: 131026 };
    const failed = await asAsha
      .post(`/api/whatsapp/conversations/${row.id}/messages`)
      .send({ text: 'Hello' });
    expect(failed.status).toBe(502);
    const kept = await WhatsAppMessage.findOne({ direction: 'outbound' }).lean();
    expect(kept).toMatchObject({ status: 'failed', errorCode: '131026' });
    expect(kept.errorMessage).toContain('not a valid WhatsApp user');
  });
});

describe('a bulk WhatsApp template', () => {
  it('goes to everyone in a bundle who has a number, and is kept in their conversation', async () => {
    const { runCampaignStep } = await import('../services/campaigns.service.js');
    const account = (await asCeo.get('/api/accounts?search=Shakti')).body.data[0];
    await asCeo
      .post(`/api/accounts/${account.id}/contacts`)
      .send({ name: 'No Number', email: 'x@y.example' });
    const bundle = (
      await asCeo
        .post('/api/bundles')
        .send({ name: 'Foundries', accountIds: [account.id], includeCompany: false })
    ).body.data;
    expect(bundle.memberCount).toBe(2);

    const sending = await asCeo.post('/api/campaigns').send({
      name: 'Diwali greeting',
      channel: 'whatsapp',
      bundleId: bundle.id,
      gapSeconds: 10,
      templateName: 'festival_greeting',
      templateLanguage: 'en',
      templateParams: ['{{name}}', 'EngenX'],
    });
    expect(sending.status).toBe(201);
    expect(sending.body.data.counts).toMatchObject({ total: 2, pending: 1, skipped: 1 });
    const id = sending.body.data.id;
    expect(
      (
        await asCeo
          .post('/api/campaigns')
          .send({ ...sending.request._data, templateName: 'Not A Template Name' })
      ).status,
    ).toBe(400);

    await asCeo.post(`/api/campaigns/${id}/start`);
    expect(await runCampaignStep(id)).toBe('sent');
    expect(await runCampaignStep(id)).toBe('finished');
    expect(meta.sent[0].body).toMatchObject({
      to: CUSTOMER,
      type: 'template',
      template: {
        name: 'festival_greeting',
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Rajesh Patil' },
              { type: 'text', text: 'EngenX' },
            ],
          },
        ],
      },
    });
    const rows = (await asCeo.get(`/api/campaigns/${id}/recipients`)).body.data;
    expect(rows.map((row) => [row.name, row.status, row.reason])).toEqual([
      ['Rajesh Patil', 'sent', null],
      ['No Number', 'skipped', 'No phone number is saved.'],
    ]);
    const kept = await WhatsAppMessage.findOne({ type: 'template' }).lean();
    expect(kept).toMatchObject({
      direction: 'outbound',
      templateName: 'festival_greeting',
      status: 'sent',
    });
    expect((await Activity.find({ type: 'WHATSAPP' }).lean()).map((entry) => entry.title)).toEqual([
      'WhatsApp to Rajesh Patil',
    ]);
  });
});
