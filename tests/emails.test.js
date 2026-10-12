import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// The settings exist only for this test file. Gmail, Google's token service and the AI are all
// replaced by `fetch` below: a small pretend mailbox, and prepared AI answers.
Object.assign(process.env, {
  GOOGLE_WORKSPACE_CLIENT_ID: 'workspace-client-id',
  GOOGLE_WORKSPACE_CLIENT_SECRET: 'workspace-client-secret',
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  OPENROUTER_API_KEY: 'test-openrouter-key',
});

const OWN = 'asha@engenx.in';
const mailbox = { messages: [], historyId: 100, historyIsGone: false };
const gmailCalls = [];
let aiAnswers = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64url');

/** Put a message into the pretend mailbox. */
function deliver({
  from,
  to = [OWN],
  cc = [],
  subject = 'Hello',
  text = 'Hi',
  thread,
  labels = ['INBOX'],
}) {
  mailbox.historyId += 1;
  const id = `m${mailbox.messages.length + 1}`;
  mailbox.messages.push({
    id,
    threadId: thread ?? `t-${id}`,
    labelIds: labels,
    internalDate: String(Date.UTC(2026, 9, 12, 6, mailbox.messages.length)),
    snippet: text.slice(0, 60),
    historyId: mailbox.historyId,
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: to.join(', ') },
        ...(cc.length ? [{ name: 'Cc', value: cc.join(', ') }] : []),
        { name: 'Subject', value: subject },
        { name: 'Message-ID', value: `<${id}@mail.example>` },
      ],
      parts: [{ mimeType: 'text/plain', body: { data: b64(text) } }],
    },
  });
  return id;
}

vi.stubGlobal('fetch', async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.host === 'openrouter.ai') {
    const body = JSON.parse(options.body);
    return json({
      model: body.models[0],
      choices: [{ message: { content: JSON.stringify(aiAnswers.shift()) } }],
      usage: { prompt_tokens: 200, completion_tokens: 50, cost: 0.0005 },
    });
  }
  if (url.host !== 'gmail.googleapis.com') return json({});
  const path = url.pathname.replace('/gmail/v1/users/me', '');
  gmailCalls.push(
    `${options.method ?? 'GET'} ${path}${url.searchParams.get('format') ? ` ${url.searchParams.get('format')}` : ''}`,
  );
  if (path === '/profile') return json({ emailAddress: OWN, historyId: String(mailbox.historyId) });
  if (path === '/messages') {
    return json({
      messages: [...mailbox.messages].reverse().map(({ id, threadId }) => ({ id, threadId })),
    });
  }
  if (path === '/history') {
    if (mailbox.historyIsGone)
      return json({ error: { message: 'Requested entity was not found.' } }, 404);
    const start = Number(url.searchParams.get('startHistoryId'));
    const added = mailbox.messages.filter((message) => message.historyId > start);
    return json({
      history: added.map((message) => ({
        messagesAdded: [{ message: { id: message.id, threadId: message.threadId } }],
      })),
      historyId: String(mailbox.historyId),
    });
  }
  if (path === '/messages/send') {
    const { raw, threadId } = JSON.parse(options.body);
    const [head, body] = Buffer.from(raw, 'base64url').toString('utf8').split('\r\n\r\n');
    const header = (name) =>
      head
        .split('\r\n')
        .find((line) => line.startsWith(`${name}: `))
        ?.slice(name.length + 2);
    const id = deliver({
      from: header('From'),
      to: header('To').split(', '),
      subject: header('Subject'),
      text: Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'),
      thread: threadId,
      labels: ['SENT'],
    });
    mailbox.lastSent = {
      inReplyTo: header('In-Reply-To'),
      to: header('To'),
      subject: header('Subject'),
    };
    return json({ id, threadId: mailbox.messages.at(-1).threadId });
  }
  const message = mailbox.messages.find((item) => `/messages/${item.id}` === path);
  return message ? json(message) : json({ error: { message: 'Not Found' } }, 404);
});

const { createApp } = await import('../app.js');
const { createSessionMiddleware } = await import('../middleware/session.js');
const { Activity } = await import('../models/activity.model.js');
const { Email, EmailThread } = await import('../models/email.model.js');
const { Notification } = await import('../models/notification.model.js');
const { Role } = await import('../models/role.model.js');
const { User } = await import('../models/user.model.js');
const { runSeed, seedStartingLists, seedStatusLists } = await import('../seeds/seed.js');
const { loadRequestUser } = await import('../services/auth.service.js');
const { syncMailbox } = await import('../services/emailSync.service.js');
const { completeConnect } = await import('../services/googleConnection.service.js');
const { clearTestDb, startTestDbWithTransactions, stopTestDb } =
  await import('./helpers/testDb.js');

const PASSWORD = 'correct-horse-battery';
const CUSTOMER = 'asha.verma@bharatforge.example';
let app;
let asha;
let asAsha;
let asOther;
let asCeo;
let leadId;
let accountId;

async function signedInAs(user) {
  const client = request.agent(app);
  const response = await client
    .post('/api/auth/login')
    .send({ email: user.email, password: PASSWORD });
  expect(response.status).toBe(200);
  return client;
}
const threadsOf = async (client, query = '') =>
  (await client.get(`/api/emails/threads${query}`)).body.data;

beforeAll(async () => {
  await startTestDbWithTransactions(); // creating a lead uses a transaction
  app = createApp({ sessionMiddleware: createSessionMiddleware() });
});
afterAll(stopTestDb);

beforeEach(async () => {
  await clearTestDb();
  Object.assign(mailbox, { messages: [], historyId: 100, historyIsGone: false, lastSent: null });
  gmailCalls.length = 0;
  aiAnswers = [];
  await runSeed({ productName: 'P', companyName: 'C', workspaceDomain: 'engenx.in' });
  await seedStatusLists();
  await seedStartingLists();
  const roles = Object.fromEntries((await Role.find()).map((role) => [role.name, role]));
  const makeUser = (email, name, roleName) =>
    User.create({
      email,
      name,
      roleId: roles[roleName]._id,
      status: 'active',
      password: PASSWORD,
      isWorkspaceAccount: true,
    });
  const [first, second, third] = await Promise.all([
    makeUser(OWN, 'Asha Agent', 'Sales Agent'),
    makeUser('omar@engenx.in', 'Omar Agent', 'Sales Agent'),
    makeUser('ceo@engenx.in', 'Kunal CEO', 'CEO'),
  ]);
  [asAsha, asOther, asCeo] = await Promise.all([first, second, third].map(signedInAs));
  asha = await loadRequestUser(first._id);

  const created = await asAsha.post('/api/accounts/quick-add').send({
    account: { name: 'Bharat Forge' },
    contacts: [{ name: 'Asha Verma', email: CUSTOMER }],
    lead: { name: 'OEE for press line' },
  });
  accountId = created.body.data.account.id;
  leadId = created.body.data.lead.id;
  await completeConnect(asha, {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresInSec: 3600,
    scopes: [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/calendar.events',
    ],
    googleEmail: OWN,
    hostedDomain: 'engenx.in',
  });
});

describe('reading a mailbox', () => {
  it('keeps only mail with people of the CRM, and never fetches the text of the rest', async () => {
    const customerMail = deliver({
      from: `Asha Verma <${CUSTOMER}>`,
      subject: 'Pilot on two presses',
      text: 'Can you share a plan for the pilot?',
    });
    const newsletter = deliver({
      from: 'news@shop.example',
      subject: 'Sale!',
      text: 'Private shopping mail',
    });
    const colleague = deliver({ from: 'omar@engenx.in', subject: 'Lunch?', text: 'Private chat' });
    deliver({ from: CUSTOMER, subject: 'A draft', labels: ['DRAFT'] });

    expect(await syncMailbox(asha._id)).toEqual({ looked: 4, kept: 1 });
    const emails = await Email.find().lean();
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({
      gmailMessageId: customerMail,
      direction: 'inbound',
      from: CUSTOMER,
      fromName: 'Asha Verma',
      subject: 'Pilot on two presses',
      text: 'Can you share a plan for the pilot?',
    });
    // The text of the other mails was never asked for.
    expect(gmailCalls).toContain(`GET /messages/${newsletter} metadata`);
    expect(gmailCalls).not.toContain(`GET /messages/${newsletter} full`);
    expect(gmailCalls).not.toContain(`GET /messages/${colleague} full`);

    // The conversation knows who it is with, and shows on the lead's timeline.
    const thread = await EmailThread.findOne().lean();
    expect(String(thread.accountId)).toBe(accountId);
    expect(String(thread.opportunityId)).toBe(leadId);
    expect(thread).toMatchObject({
      messageCount: 1,
      lastDirection: 'inbound',
      subject: 'Pilot on two presses',
    });
    const entry = await Activity.findOne({ type: 'EMAIL' }).lean();
    expect(entry).toMatchObject({
      direction: 'inbound',
      title: 'Email from Asha Verma: Pilot on two presses',
    });
    expect(String(entry.opportunityId)).toBe(leadId);
    // The first reading tells nobody: it is old mail.
    expect(await Notification.countDocuments()).toBe(0);

    // Again: nothing is stored twice.
    expect(await syncMailbox(asha._id)).toEqual({ looked: 0, kept: 0 });
    expect(await Email.countDocuments()).toBe(1);
  });

  it('new mail later: kept, announced, read by the AI; a kept conversation keeps its later mails', async () => {
    const first = deliver({ from: CUSTOMER, subject: 'Pilot', text: 'First mail', thread: 't1' });
    await syncMailbox(asha._id);

    aiAnswers = [
      {
        category: 'quotation_request',
        needsReply: true,
        summary: 'She asks for a price for the pilot.',
        suggestedAction: 'Send the pilot proposal.',
      },
    ];
    deliver({
      from: CUSTOMER,
      subject: 'Re: Pilot',
      text: 'What would the pilot cost?',
      thread: 't1',
    });
    // Somebody who is not in the CRM joins the same conversation: still kept.
    deliver({
      from: 'purchase@bharatforge.example',
      subject: 'Re: Pilot',
      text: 'Adding myself.',
      thread: 't1',
    });
    aiAnswers.push({
      category: 'information',
      needsReply: false,
      summary: 'Purchase joined the conversation.',
      suggestedAction: '',
    });
    expect(await syncMailbox(asha._id)).toEqual({ looked: 2, kept: 2 });

    const thread = await EmailThread.findOne().lean();
    expect(thread.messageCount).toBe(3);
    expect(thread.participants.sort()).toEqual([CUSTOMER, 'purchase@bharatforge.example']);
    expect(thread.ai).toMatchObject({ category: 'information', needsReply: false });
    const told = await Notification.find().sort({ _id: 1 }).lean();
    expect(told.map((item) => [item.type, item.title])).toEqual([
      ['email_received', 'New mail from Asha Verma'],
      // The sender who is not in the CRM is named by their address.
      ['email_received', 'New mail from purchase@bharatforge.example'],
    ]);
    expect(told[0].link).toBe(`/inbox?thread=${thread._id}`);
    expect(first).toBe('m1');
  });

  it('when Gmail forgot the history, the last days are looked at again without doubles', async () => {
    deliver({ from: CUSTOMER, subject: 'One', thread: 't1' });
    await syncMailbox(asha._id);
    deliver({ from: CUSTOMER, subject: 'Two', thread: 't2' });
    mailbox.historyIsGone = true;
    expect(await syncMailbox(asha._id)).toEqual({ looked: 2, kept: 1 });
    expect(await Email.countDocuments()).toBe(2);
  });
});

describe('who sees a conversation', () => {
  it('the owner; the manager line when it is linked; nobody else', async () => {
    deliver({ from: CUSTOMER, subject: 'Linked', thread: 't1' });
    // People of two companies in one mail: linked to nothing, so only the owner sees it.
    await asCeo.post('/api/accounts/quick-add').send({
      account: { name: 'Thermax' },
      contacts: [{ name: 'Ravi Kumar', email: 'ravi@thermax.example' }],
    });
    deliver({ from: 'ravi@thermax.example', cc: [CUSTOMER], subject: 'Both of us', thread: 't2' });
    await syncMailbox(asha._id);

    expect((await threadsOf(asAsha)).map((thread) => thread.subject).sort()).toEqual([
      'Both of us',
      'Linked',
    ]);
    expect((await threadsOf(asCeo)).map((thread) => thread.subject)).toEqual(['Linked']);
    expect(await threadsOf(asOther)).toEqual([]);

    const [linked] = await threadsOf(asCeo);
    expect(linked).toMatchObject({
      owner: { name: 'Asha Agent' },
      contact: { name: 'Asha Verma' },
      account: { name: 'Bharat Forge' },
      lead: { name: 'OEE for press line' },
      isWaitingForUs: true,
      permissions: { canReply: false }, // the CEO reads; answering is from one's own mailbox
    });
    expect((await asCeo.get(`/api/emails/threads/${linked.id}`)).body.data.messages).toHaveLength(
      1,
    );
    expect((await asOther.get(`/api/emails/threads/${linked.id}`)).status).toBe(404);
    const unlinked = (await threadsOf(asAsha)).find((thread) => thread.subject === 'Both of us');
    expect(unlinked.account).toBeNull();
    expect((await asCeo.get(`/api/emails/threads/${unlinked.id}`)).status).toBe(404);
    expect((await threadsOf(asAsha, '?view=waiting&search=linked')).map((t) => t.subject)).toEqual([
      'Linked',
    ]);
    expect((await threadsOf(asAsha, `?opportunityId=${leadId}`)).map((t) => t.subject)).toEqual([
      'Linked',
    ]);
    expect((await request(app).get('/api/emails/threads')).status).toBe(401);
  });
});

describe('answering', () => {
  it('goes out from my own mailbox inside the conversation, and is kept', async () => {
    deliver({ from: CUSTOMER, subject: 'Pilot', text: 'Can we talk on Friday?', thread: 't1' });
    await syncMailbox(asha._id);
    const [thread] = await threadsOf(asAsha);

    const sent = await asAsha
      .post('/api/emails/send')
      .send({ threadId: thread.id, text: 'Yes, Friday at 11 works.' });
    expect(sent.status).toBe(200);
    expect(sent.body.data).toEqual({ sent: true, isKept: true, threadId: thread.id });
    expect(mailbox.lastSent).toEqual({
      inReplyTo: '<m1@mail.example>',
      to: CUSTOMER,
      subject: 'Re: Pilot',
    });

    const detail = (await asAsha.get(`/api/emails/threads/${thread.id}`)).body.data;
    expect(detail.messages.map((message) => [message.direction, message.text])).toEqual([
      ['inbound', 'Can we talk on Friday?'],
      ['outbound', 'Yes, Friday at 11 works.'],
    ]);
    expect(detail.isWaitingForUs).toBe(false);
    expect(
      (await Activity.find({ type: 'EMAIL' }).sort({ _id: 1 }).lean()).map((entry) => entry.title),
    ).toEqual(['Email from Asha Verma: Pilot', 'Email to Asha Verma: Re: Pilot']);

    // Someone who can read the conversation still cannot answer from another person's mailbox.
    expect(
      (await asCeo.post('/api/emails/send').send({ threadId: thread.id, text: 'Hi' })).status,
    ).toBe(409);
    expect(
      (await asOther.post('/api/emails/send').send({ threadId: thread.id, text: 'Hi' })).status,
    ).toBe(409);
    expect(
      (await asAsha.post('/api/emails/send').send({ threadId: thread.id, text: '' })).status,
    ).toBe(400);
  });

  it('a new mail: kept when it goes to a person of the CRM, only sent otherwise', async () => {
    const known = await asAsha
      .post('/api/emails/send')
      .send({ to: [CUSTOMER], subject: 'Plant visit', text: 'May we visit next week?' });
    expect(known.body.data).toMatchObject({ sent: true, isKept: true });
    const stranger = await asAsha
      .post('/api/emails/send')
      .send({ to: ['someone@else.example'], subject: 'Hello', text: 'Not a customer' });
    expect(stranger.body.data).toEqual({ sent: true, isKept: false, threadId: null });
    expect(await Email.countDocuments()).toBe(1);
    expect((await asAsha.post('/api/emails/send').send({ text: 'No recipient' })).status).toBe(400);
  });

  it('the AI drafts an answer for the owner to change; it sends nothing', async () => {
    deliver({ from: CUSTOMER, subject: 'Pilot', text: 'What would the pilot cost?', thread: 't1' });
    await syncMailbox(asha._id);
    const [thread] = await threadsOf(asAsha);
    const before = mailbox.messages.length;

    aiAnswers = [
      { body: 'Dear Asha,\n\nThank you. The pilot would cost [price].\n\nRegards,\nAsha Agent' },
    ];
    const draft = await asAsha
      .post(`/api/emails/threads/${thread.id}/draft`)
      .send({ instruction: 'Keep it short.' });
    expect(draft.status).toBe(200);
    expect(draft.body.data.body).toContain('[price]');
    expect(mailbox.messages).toHaveLength(before); // nothing was sent
    expect((await asCeo.post(`/api/emails/threads/${thread.id}/draft`).send({})).status).toBe(403);

    aiAnswers = [
      {
        category: 'quotation_request',
        needsReply: true,
        summary: 'She asks what the pilot costs.',
        suggestedAction: 'Send a quote.',
      },
    ];
    const read = await asAsha.post(`/api/emails/threads/${thread.id}/classify`);
    expect(read.body.data.ai).toMatchObject({
      category: 'quotation_request',
      needsReply: true,
      suggestedAction: 'Send a quote.',
    });
  });
});
