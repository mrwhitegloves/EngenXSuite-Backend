import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// The WhatsApp screen (docs/WHATSAPP.md, docs/planning/whatsapp-screen.md): who sees which chat,
// starting a chat from a person, tabs and counts, replies, files both ways, templates, the
// opt-out, paging and the AI's help. Meta, the AI and S3 are replaced below: no request
// leaves the computer.
const APP_SECRET = 'whatsapp-app-secret';
Object.assign(process.env, {
  WHATSAPP_PHONE_NUMBER_ID: '111222333',
  WHATSAPP_ACCESS_TOKEN: 'whatsapp-token',
  WHATSAPP_VERIFY_TOKEN: 'verify-me-verify-me',
  WHATSAPP_APP_SECRET: APP_SECRET,
  WHATSAPP_BUSINESS_ACCOUNT_ID: '999888777',
  OPENROUTER_API_KEY: 'test-openrouter-key',
});

const TEMPLATES = [
  {
    name: 'first_contact',
    language: 'en',
    status: 'APPROVED',
    category: 'MARKETING',
    components: [
      {
        type: 'BODY',
        text: 'Hello {{1}}, this is {{2}} from EngenX. May we talk about your plant?',
      },
      { type: 'FOOTER', text: 'Reply STOP to opt out' },
    ],
  },
  {
    name: 'brochure',
    language: 'en_US',
    status: 'APPROVED',
    category: 'MARKETING',
    components: [
      { type: 'HEADER', format: 'IMAGE' },
      { type: 'BODY', text: 'Hi {{first_name}}, here is our brochure.' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Interested' }] },
    ],
  },
  { name: 'pending_one', language: 'en', status: 'PENDING', category: 'UTILITY', components: [] },
  {
    name: 'login_code',
    language: 'en',
    status: 'APPROVED',
    category: 'AUTHENTICATION',
    components: [{ type: 'BODY', text: '{{1}} is your code.' }],
  },
];

const meta = { sent: [], uploads: [], failWith: null, aiReply: '{}' };
vi.stubGlobal('fetch', async (input, options = {}) => {
  const url = String(input);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.startsWith('https://openrouter.ai/')) {
    const body = JSON.parse(options.body);
    meta.ai = body;
    return json({
      model: body.models[0],
      choices: [{ message: { content: meta.aiReply } }],
      usage: { prompt_tokens: 500, completion_tokens: 80, cost: 0.001 },
    });
  }
  if (url.startsWith('https://lookaside.example/')) {
    return new Response(Buffer.from('picture-bytes'), { status: 200 });
  }
  if (!url.startsWith('https://graph.facebook.com/')) return json({});
  const method = options.method ?? 'GET';
  if (method === 'GET') {
    if (url.includes('/message_templates')) return json({ data: TEMPLATES, paging: {} });
    if (url.includes('fields=display_phone_number')) {
      return json({
        display_phone_number: '+91 70048 10369',
        verified_name: 'EngenX',
        quality_rating: 'GREEN',
      });
    }
    // A file of a customer: its details first.
    return json({ url: 'https://lookaside.example/file', mime_type: 'image/jpeg', file_size: 13 });
  }
  if (meta.failWith) return json({ error: meta.failWith }, 400);
  if (url.endsWith('/media')) {
    meta.uploads.push({ url, type: options.body.get('type'), file: options.body.get('file') });
    return json({ id: `media-up-${meta.uploads.length}` });
  }
  meta.sent.push({ url, body: JSON.parse(options.body) });
  return json({ messages: [{ id: `wamid.out${meta.sent.length}` }] });
});

const BUCKET_URL = 'https://test-bucket.s3.ap-south-1.amazonaws.com/';
const stored = new Map();
vi.mock('../infra/storage.js', () => ({
  isStorageConfigured: () => true,
  objectUrl: (key) => `${BUCKET_URL}${key}`,
  keyFromUrl: (url) => (url?.startsWith(BUCKET_URL) ? url.slice(BUCKET_URL.length) : null),
  uploadObject: async ({ key, body }) => {
    stored.set(key, Buffer.from(body));
    return `${BUCKET_URL}${key}`;
  },
  readObject: async (key) => stored.get(key) ?? null,
  deleteObject: async (key) => {
    stored.delete(key);
  },
  toReadableUrl: async (url) => (url ? `${url}?X-Amz-Signature=test` : null),
}));

const { createApp } = await import('../app.js');
const { createSessionMiddleware } = await import('../middleware/session.js');
const { Activity } = await import('../models/activity.model.js');
const { Contact } = await import('../models/contact.model.js');
const { Document } = await import('../models/document.model.js');
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
const GRAPH = 'https://graph.facebook.com/v21.0';
const HOUR_MS = 60 * 60 * 1000;
let app;
let asAsha;
let asOmar;
let asCeo;
let ashaId;
let contactId;
let counter = 0;

const sign = (text) => `sha256=${createHmac('sha256', APP_SECRET).update(text).digest('hex')}`;
async function deliver(value) {
  const text = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba', changes: [{ field: 'messages', value }] }],
  });
  const response = await request(app)
    .post('/api/webhooks/meta/whatsapp')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', sign(text))
    .send(text);
  expect(response.status).toBe(200);
  const event = await WebhookEvent.findOne({ provider: 'whatsapp' }).sort({ _id: -1 }).lean();
  return processWebhookEvent(event._id);
}
const incoming = (from, message) => {
  counter += 1;
  return {
    contacts: [{ wa_id: from, profile: { name: 'Rajesh on WhatsApp' } }],
    messages: [
      {
        id: `wamid.in${counter}`,
        from,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'text',
        text: { body: 'Hello' },
        ...message,
      },
    ],
  };
};
const listOf = async (client, query = '') =>
  (await client.get(`/api/whatsapp/conversations${query}`)).body;
const openChat = (client, id, query = '') =>
  client.get(`/api/whatsapp/conversations/${id}${query}`);
const startChat = (client, id = contactId) =>
  client.post(`/api/whatsapp/contacts/${id}/conversation`);

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
  stored.clear();
  Object.assign(meta, { sent: [], uploads: [], failWith: null, aiReply: '{}', ai: null });
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
  [asAsha, asOmar, asCeo] = await Promise.all([asha, omar, ceo].map(signedInAs));
  await asAsha.post('/api/accounts/quick-add').send({
    account: { name: 'Shakti Castings' },
    contacts: [{ name: 'Rajesh Patil', phone_number: '+919876543210' }],
    lead: { name: 'Furnace energy monitoring' },
  });
  contactId = String((await Contact.findOne({ name: 'Rajesh Patil' }).lean())._id);
});

describe('starting a chat from a person (Accounts → People)', () => {
  it('makes the conversation once, linked to the person, company and lead', async () => {
    const first = await startChat(asAsha);
    expect(first.status).toBe(201);
    const again = await startChat(asAsha);
    expect(again.status).toBe(200);
    expect(again.body.data.conversationId).toBe(first.body.data.conversationId);

    const chat = (await openChat(asAsha, first.body.data.conversationId)).body.data;
    expect(chat).toMatchObject({
      phone: '+919876543210',
      name: 'Rajesh Patil',
      contact: { name: 'Rajesh Patil', whatsappOptIn: false, doNotCall: false },
      account: { name: 'Shakti Castings', code: expect.stringMatching(/^EGX-/) },
      lead: { name: 'Furnace energy monitoring', code: expect.stringMatching(/^EGL-/) },
      assignedTo: { name: 'Asha Agent' },
      isWindowOpen: false, // they never wrote: only a template now
      messages: [],
      hasMore: false,
    });
    // Another agent may not see the company, so not its person either.
    expect((await startChat(asOmar)).status).toBe(404);
  });

  it('a number that wrote before it was in the CRM becomes this person’s chat', async () => {
    await deliver(incoming(STRANGER, { text: { body: 'Who is this?' } }));
    const [unknown] = (await listOf(asCeo, '?view=unknown')).data;
    expect(unknown.contact).toBeNull();
    // Later the team saves this number on the person.
    await Contact.updateOne({ _id: contactId }, { $set: { phone_number: '+919000011111' } });

    const opened = await startChat(asCeo);
    expect(opened.body.data).toEqual({ conversationId: unknown.id, created: false });
    const [row] = (await listOf(asAsha)).data;
    expect(row).toMatchObject({
      id: unknown.id,
      name: 'Rajesh Patil',
      account: { name: 'Shakti Castings' },
    });
  });
});

describe('who sees a chat (like mail)', () => {
  it('follows the company and lead; an unknown number only for wider scopes', async () => {
    await deliver(incoming(CUSTOMER, { text: { body: 'Price?' } }));
    await deliver(incoming(STRANGER, { text: { body: 'Hi' } }));
    expect((await listOf(asAsha)).data.map((row) => row.name)).toEqual(['Rajesh Patil']);
    expect((await listOf(asOmar)).data).toHaveLength(0);
    expect((await listOf(asCeo)).data).toHaveLength(2);
  });

  it('linking an unknown number to a person puts its messages on their timeline', async () => {
    await deliver(incoming(STRANGER, { text: { body: 'We need a quote' } }));
    const [row] = (await listOf(asCeo)).data;
    expect(await Activity.countDocuments({ type: 'WHATSAPP' })).toBe(0);
    const link = (client) =>
      client.patch(`/api/whatsapp/conversations/${row.id}/contact`).send({ contactId });
    expect((await link(asAsha)).status).toBe(404); // not hers to see yet
    expect((await link(asCeo)).status).toBe(200);
    expect((await listOf(asAsha)).data[0]).toMatchObject({ name: 'Rajesh Patil' });
    const entries = await Activity.find({ type: 'WHATSAPP' }).lean();
    expect(entries.map((entry) => entry.title)).toEqual(['WhatsApp from Rajesh Patil']);
  });
});

describe('the list', () => {
  it('has tabs with counts, "needs reply", search and a "You:" mark', async () => {
    await deliver(incoming(CUSTOMER, { text: { body: 'What would a pilot cost?' } }));
    await deliver(incoming(STRANGER, { text: { body: 'Hi' } }));
    const all = await listOf(asCeo);
    expect(all.meta.counts).toEqual({
      all: 2,
      unread: 2,
      needs_reply: 2,
      window_open: 2,
      unknown: 1,
    });
    const known = all.data.find((row) => row.name === 'Rajesh Patil');
    expect(known).toMatchObject({ needsReply: true, lastDirection: 'inbound', unreadCount: 1 });

    await asCeo
      .post(`/api/whatsapp/conversations/${known.id}/messages`)
      .send({ text: 'Sending it today.' });
    const after = await listOf(asCeo);
    expect(after.meta.counts).toMatchObject({ needs_reply: 1, unread: 1 });
    expect(after.data.find((row) => row.id === known.id)).toMatchObject({
      needsReply: false,
      lastDirection: 'outbound',
      snippet: 'Sending it today.',
    });
    expect((await listOf(asCeo, '?view=needs_reply')).data.map((row) => row.phone)).toEqual([
      '+919000011111',
    ]);
    // Search by the company, the lead code and the number.
    expect((await listOf(asCeo, '?search=shakti')).data).toHaveLength(1);
    expect((await listOf(asCeo, `?search=${known.lead.code}`)).data).toHaveLength(1);
    expect((await listOf(asCeo, '?search=90000')).data[0].phone).toBe('+919000011111');
    // Filters: assigned person.
    expect((await listOf(asCeo, `?assignedTo=${ashaId}`)).data).toHaveLength(1);
    expect((await listOf(asCeo, '?assignedTo=unassigned')).data).toHaveLength(1);
  });
});

describe('messages', () => {
  it('a reply quotes the message, a reaction does not count as unread, a location is kept', async () => {
    await deliver(incoming(CUSTOMER, { text: { body: 'Can you visit on Monday?' } }));
    const [row] = (await listOf(asAsha)).data;
    let chat = (await openChat(asAsha, row.id)).body.data;
    const question = chat.messages[0];
    expect(question.canReply).toBe(true);

    const sent = await asAsha
      .post(`/api/whatsapp/conversations/${row.id}/messages`)
      .send({ text: 'Yes, 11 am works.', replyToId: question.id });
    expect(sent.status).toBe(200);
    const { wamid } = await WhatsAppMessage.findById(question.id).lean();
    expect(meta.sent[0].body).toMatchObject({
      context: { message_id: wamid },
      text: { body: 'Yes, 11 am works.' },
    });
    expect(sent.body.data.messages.at(-1).replyTo).toMatchObject({
      id: question.id,
      text: 'Can you visit on Monday?',
    });

    // Meta's times are whole seconds: the customer's answers come a few seconds after ours.
    const later = (seconds) => String(Math.floor(Date.now() / 1000) + seconds);
    await deliver(
      incoming(CUSTOMER, {
        type: 'reaction',
        reaction: { emoji: '👍', message_id: 'wamid.out1' },
        timestamp: later(2),
      }),
    );
    await deliver(
      incoming(CUSTOMER, {
        type: 'location',
        location: { latitude: 23.8, longitude: 86.4, name: 'Plant 2', address: 'Dhanbad' },
        context: { id: 'wamid.out1' },
        timestamp: later(3),
      }),
    );
    const [after] = (await listOf(asAsha)).data;
    expect(after.unreadCount).toBe(1); // the location; the reaction is not a message to read
    chat = (await openChat(asAsha, row.id)).body.data;
    expect(chat.messages.map((message) => message.type)).toEqual([
      'text',
      'text',
      'reaction',
      'location',
    ]);
    expect(chat.messages[2]).toMatchObject({ reaction: { emoji: '👍' }, canReply: false });
    expect(chat.messages[3]).toMatchObject({
      text: 'Plant 2, Dhanbad',
      location: { latitude: 23.8, name: 'Plant 2' },
      replyTo: { text: 'Yes, 11 am works.', direction: 'outbound' },
    });
  });

  it('a tap on a template button shows as its text and opens the 24 hours', async () => {
    const { conversationId } = (await startChat(asAsha)).body.data;
    await deliver(
      incoming(CUSTOMER, {
        type: 'button',
        button: { text: "Yes, let's talk", payload: "Yes, let's talk" },
        context: { id: 'wamid.unknown' },
      }),
    );
    const chat = (await openChat(asAsha, conversationId)).body.data;
    expect(chat.isWindowOpen).toBe(true);
    expect(chat.messages).toMatchObject([
      { direction: 'inbound', type: 'text', text: "Yes, let's talk" },
    ]);
    expect(chat.snippet).toBe("Yes, let's talk");
  });

  it('pages older messages with "before"', async () => {
    await deliver(incoming(CUSTOMER, { text: { body: 'Hello' } }));
    const [row] = (await listOf(asAsha)).data;
    const start = Date.now() - 50 * 60 * 1000;
    await WhatsAppMessage.insertMany(
      Array.from({ length: 45 }, (_, index) => ({
        conversationId: row.id,
        direction: 'inbound',
        type: 'text',
        text: `Message ${index + 1}`,
        status: 'received',
        sentAt: new Date(start + index * 1000),
      })),
    );
    const first = (await openChat(asAsha, row.id)).body.data;
    expect(first.messages).toHaveLength(40);
    expect(first.hasMore).toBe(true);
    expect(first.messages.at(-1).text).toBe('Hello');
    const older = (
      await openChat(asAsha, row.id, `?before=${encodeURIComponent(first.messages[0].sentAt)}`)
    ).body.data;
    expect(older.messages.map((message) => message.text)).toEqual([
      'Message 1',
      'Message 2',
      'Message 3',
      'Message 4',
      'Message 5',
      'Message 6',
    ]);
    expect(older.hasMore).toBe(false);
  });
});

describe('files', () => {
  it('a customer’s picture is saved to S3 and shown with a signed link', async () => {
    await deliver(
      incoming(CUSTOMER, {
        type: 'image',
        image: { id: 'meta-media-1', mime_type: 'image/jpeg', caption: 'Our furnace' },
      }),
    );
    const [row] = (await listOf(asAsha)).data;
    expect(row.snippet).toBe('Photo: Our furnace');
    const [message] = (await openChat(asAsha, row.id)).body.data.messages;
    expect(message).toMatchObject({
      type: 'image',
      text: 'Our furnace',
      media: { status: 'ready', mimeType: 'image/jpeg', size: 13 },
    });
    expect(message.media.url).toMatch(
      /^https:\/\/test-bucket.*\/whatsapp\/.*X-Amz-Signature=test$/,
    );
    expect([...stored.values()][0].toString()).toBe('picture-bytes');
  });

  it('a file is sent inside the 24 hours, checked by kind and size, and kept', async () => {
    await deliver(incoming(CUSTOMER, { text: { body: 'Send the brochure' } }));
    const [row] = (await listOf(asAsha)).data;
    const send = (buffer, name, caption = '') =>
      asAsha
        .post(`/api/whatsapp/conversations/${row.id}/files`)
        .field('caption', caption)
        .attach('file', buffer, name);

    const ok = await send(Buffer.from('%PDF-1.4 brochure'), 'Brochure 2026.pdf', 'Our brochure');
    expect(ok.status).toBe(200);
    expect(meta.uploads[0]).toMatchObject({
      url: `${GRAPH}/111222333/media`,
      type: 'application/pdf',
    });
    expect(meta.sent[0].body).toMatchObject({
      type: 'document',
      document: { id: 'media-up-1', caption: 'Our brochure', filename: 'Brochure 2026.pdf' },
    });
    expect(ok.body.data.messages.at(-1)).toMatchObject({
      type: 'document',
      text: 'Our brochure',
      sentBy: 'Asha Agent',
      media: { fileName: 'Brochure 2026.pdf', status: 'ready' },
    });

    const tooBig = await send(Buffer.alloc(6 * 1024 * 1024), 'photo.png');
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.error.message).toContain('Image files can be at most 5 MB');
    const wrong = await send(Buffer.from('MZ'), 'setup.exe');
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.message).toContain("can't be sent on WhatsApp");
  });

  it('a library document is sent without uploading it again', async () => {
    await deliver(incoming(CUSTOMER, { text: { body: 'Proposal please' } }));
    const [row] = (await listOf(asAsha)).data;
    const key = 'documents/proposal.pdf';
    stored.set(key, Buffer.from('%PDF proposal'));
    const document = await Document.create({
      name: 'Proposal',
      filename: 'proposal.pdf',
      mimeType: 'application/pdf',
      size: 13,
      url: `${BUCKET_URL}${key}`,
      uploadedBy: ashaId,
    });
    const sent = await asAsha
      .post(`/api/whatsapp/conversations/${row.id}/documents`)
      .send({ documentId: String(document._id) });
    expect(sent.status).toBe(200);
    expect(meta.sent[0].body.document).toMatchObject({
      id: 'media-up-1',
      filename: 'proposal.pdf',
    });
    const kept = await WhatsAppMessage.findOne({ type: 'document' }).lean();
    expect(kept.media.url).toBe(`${BUCKET_URL}${key}`);
  });
});

describe('why a message failed', () => {
  it('shows Meta’s reason in plain words with what to do', async () => {
    const { conversationId } = (await startChat(asAsha)).body.data;
    const send = () =>
      asAsha.post(`/api/whatsapp/conversations/${conversationId}/templates`).send({
        templateName: 'first_contact',
        language: 'en',
        values: { 1: 'Rajesh', 2: 'Asha' },
      });
    // Accepted by Meta, then given up later: the reason comes with the status.
    expect((await send()).status).toBe(200);
    await deliver({
      statuses: [
        {
          id: 'wamid.out1',
          status: 'failed',
          timestamp: '1',
          errors: [
            {
              code: 131049,
              title: 'This message was not delivered to maintain healthy ecosystem engagement.',
            },
          ],
        },
      ],
    });
    let chat = (await openChat(asAsha, conversationId)).body.data;
    expect(chat.messages[0]).toMatchObject({ status: 'failed' });
    expect(chat.messages[0].error).toContain('Meta held back this marketing message');
    expect(chat.messages[0].error).toContain('(Meta code 131049)');

    // Refused at once (payment problem): the answer and the kept message say why.
    meta.failWith = { message: 'Business eligibility payment issue', code: 131042 };
    const refused = await send();
    expect(refused.status).toBe(502);
    expect(refused.body.error.message).toContain('payment problem');
    chat = (await openChat(asAsha, conversationId)).body.data;
    expect(chat.messages.at(-1).error).toContain('(Meta code 131042)');

    // A code the CRM does not know keeps Meta's own words.
    meta.failWith = { message: 'Something new', code: 999999 };
    await send();
    chat = (await openChat(asAsha, conversationId)).body.data;
    expect(chat.messages.at(-1).error).toContain('(Meta code 999999)');
  });
});

describe('the 24-hour window and the opt-out', () => {
  it('after 24 hours text and files are refused, a template still goes', async () => {
    await deliver(incoming(CUSTOMER, { text: { body: 'Hello' } }));
    const [row] = (await listOf(asAsha)).data;
    await WhatsAppConversation.updateOne(
      { _id: row.id },
      { $set: { lastInboundAt: new Date(Date.now() - 25 * HOUR_MS) } },
    );
    const file = await asAsha
      .post(`/api/whatsapp/conversations/${row.id}/files`)
      .attach('file', Buffer.from('%PDF'), 'a.pdf');
    expect(file.status).toBe(409);
    expect(file.body.error.code).toBe('WHATSAPP_WINDOW_CLOSED');

    const template = await asAsha.post(`/api/whatsapp/conversations/${row.id}/templates`).send({
      templateName: 'first_contact',
      language: 'en',
      values: { 1: 'Rajesh', 2: 'Asha' },
    });
    expect(template.status).toBe(200);
    expect(meta.sent[0].body.template).toEqual({
      name: 'first_contact',
      language: { code: 'en' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: 'Rajesh' },
            { type: 'text', text: 'Asha' },
          ],
        },
      ],
    });
    expect(template.body.data.messages.at(-1)).toMatchObject({
      type: 'template',
      templateName: 'first_contact',
      text: 'Hello Rajesh, this is Asha from EngenX. May we talk about your plant?',
    });
  });

  it('a number that wrote STOP gets nothing at all', async () => {
    await deliver(incoming(CUSTOMER, { text: { body: 'STOP' } }));
    const [row] = (await listOf(asAsha)).data;
    expect(row.optedOut).toBe(true);
    const text = await asAsha
      .post(`/api/whatsapp/conversations/${row.id}/messages`)
      .send({ text: 'Sorry to hear that' });
    expect(text.status).toBe(409);
    expect(text.body.error.code).toBe('WHATSAPP_OPTED_OUT');
    const template = await asAsha.post(`/api/whatsapp/conversations/${row.id}/templates`).send({
      templateName: 'first_contact',
      language: 'en',
      values: { 1: 'Rajesh', 2: 'Asha' },
    });
    expect(template.status).toBe(409);
    expect(meta.sent).toHaveLength(0);
  });
});

describe('templates', () => {
  it('lists only what the CRM can send; Settings sees all with the reason', async () => {
    const sendable = (await asAsha.get('/api/whatsapp/templates')).body.data;
    expect(sendable.map((template) => template.name)).toEqual(['brochure', 'first_contact']);
    expect(sendable[0]).toMatchObject({
      headerType: 'IMAGE',
      variables: ['first_name'],
      isNamed: true,
      buttons: [{ type: 'QUICK_REPLY', text: 'Interested' }],
    });
    expect(sendable[1]).toMatchObject({
      variables: ['1', '2'],
      footerText: 'Reply STOP to opt out',
    });
    const all = (await asCeo.get('/api/whatsapp/templates?all=1')).body.data;
    expect(all.map((template) => [template.name, template.unsupported])).toEqual([
      ['brochure', null],
      ['first_contact', null],
      ['login_code', 'A sign-in code template.'],
      ['pending_one', 'Not approved by Meta yet.'],
    ]);
  });

  it('checks the variables and the header, then sends a picture header and named values', async () => {
    const { conversationId } = (await startChat(asAsha)).body.data;
    const sendTemplate = (body) =>
      asAsha.post(`/api/whatsapp/conversations/${conversationId}/templates`).send(body);

    const missing = await sendTemplate({
      templateName: 'first_contact',
      language: 'en',
      values: { 1: 'Rajesh' },
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toBe('Fill all 2 variable(s) of the template.');
    const noHeader = await sendTemplate({
      templateName: 'brochure',
      language: 'en_US',
      values: { first_name: 'Rajesh' },
    });
    expect(noHeader.status).toBe(400);
    expect(noHeader.body.error.message).toContain('needs an image');
    expect((await sendTemplate({ templateName: 'pending_one', language: 'en' })).status).toBe(400);

    const header = (
      await asAsha
        .post(`/api/whatsapp/conversations/${conversationId}/template-header`)
        .attach('file', Buffer.from('png-bytes'), 'plant.png')
    ).body.data;
    expect(header).toMatchObject({ fileName: 'plant.png', mimeType: 'image/png' });
    const sent = await sendTemplate({
      templateName: 'brochure',
      language: 'en_US',
      values: { first_name: 'Rajesh' },
      header: { url: header.url, fileName: header.fileName, mimeType: header.mimeType },
    });
    expect(sent.status).toBe(200);
    expect(meta.sent[0].body.template.components).toEqual([
      { type: 'header', parameters: [{ type: 'image', image: { id: 'media-up-1' } }] },
      {
        type: 'body',
        parameters: [{ type: 'text', parameter_name: 'first_name', text: 'Rajesh' }],
      },
    ]);
    expect(sent.body.data.messages.at(-1)).toMatchObject({
      type: 'template',
      text: 'Hi Rajesh, here is our brochure.',
      media: { fileName: 'plant.png', status: 'ready' },
    });
    // A header file of another conversation is refused.
    const other = await sendTemplate({
      templateName: 'brochure',
      language: 'en_US',
      values: { first_name: 'Rajesh' },
      header: {
        url: `${BUCKET_URL}whatsapp/someone-else/x.png`,
        fileName: 'x.png',
        mimeType: 'image/png',
      },
    });
    expect(other.status).toBe(400);
  });
});

describe('Settings → WhatsApp', () => {
  it('shows the setup and the business number', async () => {
    const status = (await asCeo.get('/api/whatsapp/status')).body.data;
    expect(status).toMatchObject({
      isConfigured: true,
      missing: [],
      hasBusinessAccount: true,
      number: { displayNumber: '+91 70048 10369', verifiedName: 'EngenX', qualityRating: 'GREEN' },
    });
  });
});

describe('the AI’s help', () => {
  it('suggests a reply in the customer’s language, only on request, and sends nothing', async () => {
    const { conversationId } = (await startChat(asAsha)).body.data;
    const before = await asAsha
      .post(`/api/whatsapp/conversations/${conversationId}/assist`)
      .send({ kind: 'suggest' });
    expect(before.body.data).toMatchObject({
      note: 'No message from them yet. Start with a template.',
      result: null,
    });
    expect(meta.ai).toBeNull();

    await deliver(incoming(CUSTOMER, { text: { body: 'Pilot ka kharcha kitna hoga?' } }));
    meta.aiReply = JSON.stringify({
      reply:
        'Namaste Rajesh ji, pilot ka kharcha aapke plant par depend karta hai. Main check karke batata hoon.',
      ask: [{ label: 'Ask about the furnaces', text: 'Aapke plant mein kitne furnace hain?' }],
      next: { label: 'Propose a call', text: 'Kya kal 10 minute ki call ho sakti hai?' },
      tips: [{ said: 'Asked for the price', answer: 'Do not give a number; offer to check.' }],
    });
    const suggestion = await asAsha
      .post(`/api/whatsapp/conversations/${conversationId}/assist`)
      .send({ kind: 'suggest' });
    expect(suggestion.status).toBe(200);
    expect(suggestion.body.data.result.reply).toContain('Rajesh ji');
    const prompt = meta.ai.messages[0].content;
    expect(prompt).toContain('SAME language and script the customer writes in');
    expect(JSON.parse(meta.ai.messages[1].content).chat).toMatchObject([
      { from: 'customer', text: 'Pilot ka kharcha kitna hoga?' },
    ]);
    expect(meta.sent).toHaveLength(0);
    expect(
      (
        await asOmar
          .post(`/api/whatsapp/conversations/${conversationId}/assist`)
          .send({ kind: 'summary' })
      ).status,
    ).toBe(404);
  });
});
