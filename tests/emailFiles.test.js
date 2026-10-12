import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// Files on customer mail, and the AI that writes a mail. Gmail and the AI are replaced by
// `fetch` below (a small pretend mailbox that understands attachments); file storage is a Map.
Object.assign(process.env, {
  GOOGLE_WORKSPACE_CLIENT_ID: 'workspace-client-id',
  GOOGLE_WORKSPACE_CLIENT_SECRET: 'workspace-client-secret',
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  OPENROUTER_API_KEY: 'test-openrouter-key',
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

const OWN = 'asha@engenx.in';
const mailbox = { messages: [], files: new Map(), historyId: 100 };
let aiAnswers = [];
let aiRequests = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

/**
 * Put a message into the pretend mailbox.
 * @param {{ files?: { filename: string, mimeType: string, content: Buffer }[] }} mail
 */
function deliver({ from, to = [OWN], subject = 'Hello', text = 'Hi', thread, labels, files = [] }) {
  mailbox.historyId += 1;
  const id = `m${mailbox.messages.length + 1}`;
  mailbox.messages.push({
    id,
    threadId: thread ?? `t-${id}`,
    labelIds: labels ?? ['INBOX'],
    internalDate: String(Date.UTC(2026, 9, 12, 6, mailbox.messages.length)),
    snippet: text.slice(0, 60),
    historyId: mailbox.historyId,
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: to.join(', ') },
        { name: 'Subject', value: subject },
        { name: 'Message-ID', value: `<${id}@mail.example>` },
      ],
      parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from(text).toString('base64url') } },
        ...files.map((file, index) => {
          const attachmentId = `${id}-a${index + 1}`;
          mailbox.files.set(attachmentId, file.content);
          return {
            filename: file.filename,
            mimeType: file.mimeType,
            body: { attachmentId, size: file.content.length },
          };
        }),
      ],
    },
  });
  return id;
}

/** Take a sent message apart: its headers, its text and its files. */
function readRaw(raw) {
  const whole = Buffer.from(raw, 'base64url').toString('utf8');
  const [head] = whole.split('\r\n\r\n');
  const header = (name) =>
    head
      .split('\r\n')
      .find((line) => line.startsWith(`${name}: `))
      ?.slice(name.length + 2);
  const unwrap = (body) => Buffer.from(body.replace(/\r\n/g, ''), 'base64');
  const boundary = /boundary="([^"]+)"/.exec(head)?.[1];
  if (!boundary) {
    return { header, text: unwrap(whole.slice(head.length + 4)).toString('utf8'), files: [] };
  }
  const parts = whole
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((part) => {
      const [partHead, body] = part.trim().split('\r\n\r\n');
      return { partHead, content: unwrap(body) };
    });
  return {
    header,
    text: parts[0].content.toString('utf8'),
    files: parts.slice(1).map((part) => ({
      filename: /filename="([^"]+)"/.exec(part.partHead)[1],
      mimeType: /Content-Type: ([^;]+);/.exec(part.partHead)[1],
      content: part.content,
    })),
  };
}

vi.stubGlobal('fetch', async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.host === 'openrouter.ai') {
    const body = JSON.parse(options.body);
    aiRequests.push(JSON.parse(body.messages.at(-1).content));
    return json({
      model: body.models[0],
      choices: [{ message: { content: JSON.stringify(aiAnswers.shift()) } }],
      usage: { prompt_tokens: 200, completion_tokens: 50, cost: 0.0005 },
    });
  }
  if (url.host !== 'gmail.googleapis.com') return json({});
  const path = url.pathname.replace('/gmail/v1/users/me', '');
  if (path === '/profile') return json({ emailAddress: OWN, historyId: String(mailbox.historyId) });
  if (path === '/messages') {
    return json({
      messages: [...mailbox.messages].reverse().map(({ id, threadId }) => ({ id, threadId })),
    });
  }
  if (path === '/history') {
    const start = Number(url.searchParams.get('startHistoryId'));
    return json({
      history: mailbox.messages
        .filter((message) => message.historyId > start)
        .map((message) => ({
          messagesAdded: [{ message: { id: message.id, threadId: message.threadId } }],
        })),
      historyId: String(mailbox.historyId),
    });
  }
  if (path === '/messages/send') {
    const { raw, threadId } = JSON.parse(options.body);
    const mail = readRaw(raw);
    const id = deliver({
      from: mail.header('From'),
      to: mail.header('To').split(', '),
      subject: mail.header('Subject'),
      text: mail.text,
      thread: threadId,
      labels: ['SENT'],
      files: mail.files,
    });
    mailbox.lastSent = { files: mail.files, threadId, inReplyTo: mail.header('In-Reply-To') };
    return json({ id, threadId: mailbox.messages.at(-1).threadId });
  }
  const attachment = /^\/messages\/[^/]+\/attachments\/(.+)$/.exec(path);
  if (attachment) {
    const content = mailbox.files.get(attachment[1]);
    return content
      ? json({ data: content.toString('base64url'), size: content.length })
      : json({ error: { message: 'Not Found' } }, 404);
  }
  const message = mailbox.messages.find((item) => `/messages/${item.id}` === path);
  return message ? json(message) : json({ error: { message: 'Not Found' } }, 404);
});

const { createApp } = await import('../app.js');
const { createSessionMiddleware } = await import('../middleware/session.js');
const { AiRun } = await import('../models/aiRun.model.js');
const { Contact } = await import('../models/contact.model.js');
const { Email } = await import('../models/email.model.js');
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
const DRAWING = Buffer.from('%PDF-1.7 the drawing of the press line');
let app;
let asha;
let asAsha;
let asOther;
let asCeo;
let accountId;
let contactId;

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
const detailOf = async (client, id) => (await client.get(`/api/emails/threads/${id}`)).body.data;

beforeAll(async () => {
  await startTestDbWithTransactions(); // creating a lead uses a transaction
  app = createApp({ sessionMiddleware: createSessionMiddleware() });
});
afterAll(stopTestDb);

beforeEach(async () => {
  await clearTestDb();
  Object.assign(mailbox, { messages: [], files: new Map(), historyId: 100, lastSent: null });
  stored.clear();
  aiAnswers = [];
  aiRequests = [];
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
  contactId = String((await Contact.findOne({ email: CUSTOMER }).lean())._id);
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

describe('files on customer mail', () => {
  it('a file that comes with a mail is copied to storage; the mail keeps only its address', async () => {
    deliver({
      from: CUSTOMER,
      subject: 'Drawing',
      text: 'The drawing is attached.',
      thread: 't1',
      files: [{ filename: 'press line.pdf', mimeType: 'application/pdf', content: DRAWING }],
    });
    await syncMailbox(asha._id);

    const email = await Email.findOne().lean();
    expect(email.attachments).toEqual([
      {
        filename: 'press line.pdf',
        mimeType: 'application/pdf',
        size: DRAWING.length,
        url: `${BUCKET_URL}emails/${email._id}/1-press line.pdf`,
      },
    ]);
    expect(stored.get(`emails/${email._id}/1-press line.pdf`)).toEqual(DRAWING);

    // On the screen: a signed link.
    const [thread] = await threadsOf(asAsha);
    const detail = await detailOf(asAsha, thread.id);
    expect(detail.messages[0].attachments[0]).toMatchObject({
      filename: 'press line.pdf',
      size: DRAWING.length,
      link: `${email.attachments[0].url}?X-Amz-Signature=test`,
    });

    // The files of the company: for the people who may see the company and the conversation.
    const files = await asAsha.get(`/api/emails/files?accountId=${accountId}`);
    expect(files.body.data).toHaveLength(1);
    expect(files.body.data[0]).toMatchObject({
      filename: 'press line.pdf',
      direction: 'inbound',
      subject: 'Drawing',
    });
    expect((await asCeo.get(`/api/emails/files?accountId=${accountId}`)).body.data).toHaveLength(1);
    expect((await asOther.get(`/api/emails/files?accountId=${accountId}`)).status).toBe(404);
    expect((await asAsha.get('/api/emails/files')).status).toBe(400);

    // The conversations of one person.
    expect(await threadsOf(asAsha, `?contactId=${contactId}`)).toHaveLength(1);
    expect(await threadsOf(asAsha, `?contactId=${accountId}`)).toHaveLength(0);
  });

  it('a mail goes out with a file from my device and a file from an earlier mail', async () => {
    deliver({
      from: CUSTOMER,
      subject: 'Drawing',
      text: 'The drawing is attached.',
      thread: 't1',
      files: [{ filename: 'press line.pdf', mimeType: 'application/pdf', content: DRAWING }],
    });
    await syncMailbox(asha._id);
    const [thread] = await threadsOf(asAsha);
    const earlier = (await detailOf(asAsha, thread.id)).messages[0].attachments[0];

    const uploaded = await asAsha
      .post('/api/emails/attachments')
      .attach('file', Buffer.from('our offer'), {
        filename: 'offer.txt',
        contentType: 'text/plain',
      });
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.data).toMatchObject({ filename: 'offer.txt', mimeType: 'text/plain' });
    expect(uploaded.body.data.url).toContain(`email-uploads/${asha._id}/`);
    expect((await asAsha.post('/api/emails/attachments')).status).toBe(400);

    const sent = await asAsha.post('/api/emails/send').send({
      threadId: thread.id,
      text: 'Our offer and your drawing, with our notes.',
      attachments: [
        { url: uploaded.body.data.url, filename: 'offer.txt', mimeType: 'text/plain' },
        { url: earlier.url },
      ],
    });
    expect(sent.status).toBe(200);
    expect(mailbox.lastSent.threadId).toBe('t1'); // the same conversation
    expect(mailbox.lastSent.inReplyTo).toBe('<m1@mail.example>');
    expect(mailbox.lastSent.files).toEqual([
      { filename: 'offer.txt', mimeType: 'text/plain', content: Buffer.from('our offer') },
      { filename: 'press line.pdf', mimeType: 'application/pdf', content: DRAWING },
    ]);

    // The mail that went out is kept with its own copies of the files.
    const detail = await detailOf(asAsha, thread.id);
    expect(detail.messages).toHaveLength(2);
    expect(detail.messages[1].text).toBe('Our offer and your drawing, with our notes.');
    expect(
      detail.messages[1].attachments.map((file) => [file.filename, Boolean(file.link)]),
    ).toEqual([
      ['offer.txt', true],
      ['press line.pdf', true],
    ]);
    expect((await asAsha.get(`/api/emails/files?accountId=${accountId}`)).body.data).toHaveLength(
      3,
    );
  });

  it('refuses a file that is not mine to send', async () => {
    deliver({
      from: CUSTOMER,
      subject: 'Drawing',
      thread: 't1',
      files: [{ filename: 'press line.pdf', mimeType: 'application/pdf', content: DRAWING }],
    });
    await syncMailbox(asha._id);
    const customerFile = (await Email.findOne().lean()).attachments[0].url;
    const uploaded = await asAsha
      .post('/api/emails/attachments')
      .attach('file', Buffer.from('our offer'), {
        filename: 'offer.txt',
        contentType: 'text/plain',
      });
    stored.set('backups/2026-10-12.gz', Buffer.from('everything'));
    const before = mailbox.messages.length;

    // Omar has a mailbox of his own, but none of these files is his.
    const omar = await loadRequestUser((await User.findOne({ email: 'omar@engenx.in' }))._id);
    await completeConnect(omar, {
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresInSec: 3600,
      scopes: [
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/calendar.events',
      ],
      googleEmail: 'omar@engenx.in',
      hostedDomain: 'engenx.in',
    });
    const send = (client, url) =>
      client
        .post('/api/emails/send')
        .send({ to: [CUSTOMER], subject: 'Hello', text: 'Hi', attachments: [{ url }] });
    expect((await send(asOther, uploaded.body.data.url)).status).toBe(400); // another person's upload
    expect((await send(asOther, customerFile)).status).toBe(400); // a conversation he cannot see
    expect((await send(asAsha, `${BUCKET_URL}backups/2026-10-12.gz`)).status).toBe(400);
    expect((await send(asAsha, 'https://elsewhere.example/file.pdf')).status).toBe(400);
    expect(mailbox.messages).toHaveLength(before); // nothing went out
  });
});

describe('the AI writes a mail', () => {
  const written = (body, subject = 'Drawing') => ({ subject, body });

  it('the next mail of a conversation, then a change to it; nothing is sent or saved', async () => {
    deliver({ from: CUSTOMER, subject: 'Drawing', text: 'Please send your offer.', thread: 't1' });
    await syncMailbox(asha._id);
    const [thread] = await threadsOf(asAsha);
    const before = mailbox.messages.length;

    aiAnswers = [written('Dear Asha,\n\nOur offer follows by [date].\n\nRegards,\nAsha Agent')];
    const first = await asAsha
      .post('/api/emails/write')
      .send({ mode: 'follow_up', threadId: thread.id, instruction: 'Say the offer is coming.' });
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual({
      subject: 'Drawing',
      body: 'Dear Asha,\n\nOur offer follows by [date].\n\nRegards,\nAsha Agent',
    });
    expect(aiRequests[0]).toMatchObject({
      mode: 'follow_up',
      conversationSubject: 'Drawing',
      sender: 'Asha Agent',
      instruction: 'Say the offer is coming.',
      customer: { person: 'Asha Verma', company: 'Bharat Forge' },
    });
    expect(aiRequests[0].conversation).toHaveLength(1);
    expect(aiRequests[0].currentDraft).toBeUndefined();

    // "Change this part": the mail as it stands goes back with the new wish.
    aiAnswers = [written('Dear Asha,\n\nOur offer follows by Friday.\n\nRegards,\nAsha Agent')];
    const second = await asAsha.post('/api/emails/write').send({
      mode: 'follow_up',
      threadId: thread.id,
      instruction: 'Say Friday instead of the open date.',
      draft: first.body.data,
    });
    expect(second.body.data.body).toContain('Friday');
    expect(aiRequests[1].currentDraft).toEqual(first.body.data);

    expect(mailbox.messages).toHaveLength(before);
    expect(await Email.countDocuments()).toBe(1);
    expect(await AiRun.countDocuments({ task: 'writeEmail' })).toBe(2);

    // Only in one's own mailbox; and an answer needs a customer message.
    expect(
      (await asCeo.post('/api/emails/write').send({ mode: 'reply', threadId: thread.id })).status,
    ).toBe(403);
    expect(
      (await asOther.post('/api/emails/write').send({ mode: 'reply', threadId: thread.id })).status,
    ).toBe(404);
  });

  it('a first mail to a company, with a subject', async () => {
    aiAnswers = [
      written('Dear Asha,\n\nMay we visit your plant?\n\nRegards,\nAsha Agent', 'Visit'),
    ];
    const response = await asAsha.post('/api/emails/write').send({
      mode: 'new',
      accountId,
      contactId,
      instruction: 'Ask for a plant visit.',
    });
    expect(response.body.data.subject).toBe('Visit');
    expect(aiRequests[0]).toMatchObject({ mode: 'new', conversation: [] });
    expect(aiRequests[0].customer).toMatchObject({ person: 'Asha Verma', company: 'Bharat Forge' });

    expect((await asOther.post('/api/emails/write').send({ mode: 'new', accountId })).status).toBe(
      404,
    );
    expect((await asAsha.post('/api/emails/write').send({ mode: 'new' })).status).toBe(400);
  });
});
