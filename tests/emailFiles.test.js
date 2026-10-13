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
  GMAIL_PUSH_TOPIC: 'projects/test-project/topics/gmail-push',
  GMAIL_PUSH_TOKEN: 'push-token-push-token-push-token',
});
const PUSH_TOKEN = 'push-token-push-token-push-token';

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
function deliver({
  from,
  to = [OWN],
  subject = 'Hello',
  text = 'Hi',
  html,
  thread,
  labels,
  files = [],
}) {
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
        ...(html
          ? [{ mimeType: 'text/html', body: { data: Buffer.from(html).toString('base64url') } }]
          : []),
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
  if (path === '/watch') {
    mailbox.watchedTopic = JSON.parse(options.body).topicName;
    return json({ historyId: '1', expiration: String(Date.now() + 7 * 24 * 3600 * 1000) });
  }
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
const { Email, EmailThread } = await import('../models/email.model.js');
const { Notification } = await import('../models/notification.model.js');
const { Role } = await import('../models/role.model.js');
const { User } = await import('../models/user.model.js');
const { runSeed, seedStartingLists, seedStatusLists } = await import('../seeds/seed.js');
const { loadRequestUser } = await import('../services/auth.service.js');
const { runCampaignStep } = await import('../services/campaigns.service.js');
const { runFollowUpReminders } = await import('../services/emailAssist.service.js');
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

describe('the AI helps on a conversation', () => {
  let thread;
  beforeEach(async () => {
    deliver({
      from: CUSTOMER,
      subject: 'Pilot',
      text: 'Please send the offer by Friday. Can we talk on Friday at 3 pm?',
      thread: 't1',
      files: [
        { filename: 'spec.txt', mimeType: 'text/plain', content: Buffer.from('3 presses, 400 t') },
      ],
    });
    await syncMailbox(asha._id);
    [thread] = await threadsOf(asAsha);
  });
  const assist = (client, body) =>
    client.post(`/api/emails/threads/${thread.id}/assist`).send(body);

  it('a summary, for everyone who may read the conversation', async () => {
    const summary = {
      summary: 'The customer wants an offer and a call on Friday.',
      customerAsks: ['An offer by Friday'],
      wePromised: [],
      openQuestions: ['The time of the call'],
    };
    aiAnswers = [summary, summary];
    expect((await assist(asAsha, { kind: 'summary' })).body.data).toEqual(summary);
    expect((await assist(asCeo, { kind: 'summary' })).status).toBe(200);
    expect(aiRequests[0].conversation[0]).toMatchObject({
      direction: 'inbound',
      files: ['spec.txt'],
    });
    expect((await assist(asOther, { kind: 'summary' })).status).toBe(404);
    expect((await assist(asAsha, { kind: 'nonsense' })).status).toBe(400);
  });

  it('the tasks in it, with a day; nothing is created by the AI', async () => {
    aiAnswers = [
      {
        tasks: [
          { title: 'Send the offer', dueInDays: 2, reason: 'She asks for it by Friday.' },
          { title: 'Confirm the call', dueInDays: null, reason: 'She proposes Friday 3 pm.' },
        ],
      },
    ];
    const before = Date.now();
    const answer = (await assist(asAsha, { kind: 'tasks' })).body.data;
    expect(answer.tasks.map((task) => task.title)).toEqual(['Send the offer', 'Confirm the call']);
    expect(new Date(answer.tasks[0].dueAt) - before).toBeGreaterThan(47 * 3600 * 1000);
    expect(answer.tasks[1].dueAt).toBeNull();
    expect(answer).toMatchObject({ accountId, contactId });
    expect(answer.opportunityId).toBeTruthy();
    expect(aiRequests[0].today).toMatch(/^\d{4}-\d{2}-\d{2} \(\w+day\)$/);
    expect((await asAsha.get('/api/tasks?view=all')).body.data).toEqual([]);
  });

  it('a meeting it asks for, with its time in India', async () => {
    aiAnswers = [
      {
        wantsMeeting: true,
        title: 'Call about the pilot',
        mode: 'online',
        startAt: '2026-10-16T15:00',
        durationMinutes: 30,
        reason: 'She asks to talk on Friday at 3 pm.',
      },
    ];
    const answer = (await assist(asAsha, { kind: 'meeting' })).body.data;
    expect(answer).toMatchObject({ wantsMeeting: true, mode: 'online', durationMinutes: 30 });
    expect(answer.startAt).toBe('2026-10-16T09:30:00.000Z');
  });

  it('a check and three versions of my mail, only in my own mailbox', async () => {
    aiAnswers = [
      {
        isReadyToSend: false,
        issues: [{ kind: 'missing', text: 'The price is still [price].' }],
        unansweredQuestions: ['Can we talk on Friday at 3 pm?'],
      },
    ];
    const review = await assist(asAsha, { kind: 'review', draft: 'The pilot costs [price].' });
    expect(review.body.data.issues).toEqual([
      { kind: 'missing', text: 'The price is still [price].' },
    ]);
    expect(aiRequests[0].draft).toBe('The pilot costs [price].');
    expect((await assist(asAsha, { kind: 'review' })).status).toBe(400);

    aiAnswers = [
      {
        variants: [
          { label: 'short', body: 'Dear Asha,\n\nFriday 3 pm works.\n\nRegards,\nAsha Agent' },
          {
            label: 'detailed',
            body: 'Dear Asha,\n\nFriday 3 pm works. The offer follows.\n\nRegards,\nAsha Agent',
          },
          {
            label: 'formal',
            body: 'Dear Ms Verma,\n\nFriday at 3 pm suits us.\n\nYours sincerely,\nAsha Agent',
          },
        ],
      },
    ];
    const variants = await assist(asAsha, { kind: 'variants', instruction: 'Agree to Friday.' });
    expect(variants.body.data.variants.map((item) => item.label)).toEqual([
      'short',
      'detailed',
      'formal',
    ]);
    expect(aiRequests[1]).toMatchObject({
      mode: 'reply',
      sender: 'Asha Agent',
      instruction: 'Agree to Friday.',
      customer: { person: 'Asha Verma', company: 'Bharat Forge' },
    });
    // The CEO reads the conversation but does not write in another person's mailbox.
    expect((await assist(asCeo, { kind: 'variants' })).status).toBe(403);
    expect((await assist(asCeo, { kind: 'review', draft: 'Hi' })).status).toBe(403);
    expect(mailbox.messages).toHaveLength(1); // nothing was sent
  });

  it('what a file of a mail says, for the people who may see the mail', async () => {
    const { url } = (await Email.findOne().lean()).attachments[0];
    const summary = {
      summary: 'A short specification.',
      keyPoints: ['3 presses'],
      figures: ['400 t: press force'],
    };
    aiAnswers = [summary];
    const answer = await asAsha.post('/api/emails/files/summary').send({ url });
    expect(answer.body.data).toEqual({ filename: 'spec.txt', ...summary });
    expect(aiRequests[0]).toEqual({ name: 'spec.txt', text: '3 presses, 400 t' });
    expect((await asOther.post('/api/emails/files/summary').send({ url })).status).toBe(404);
    expect(
      (await asAsha.post('/api/emails/files/summary').send({ url: `${BUCKET_URL}backups/x.gz` }))
        .status,
    ).toBe(404);
  });

  it('the mood of the customer is read with the rest', async () => {
    const reading = {
      category: 'follow_up',
      needsReply: true,
      summary: 'She waits.',
      suggestedAction: '',
    };
    aiAnswers = [{ ...reading, sentiment: 'negative' }, reading];
    const first = await asAsha.post(`/api/emails/threads/${thread.id}/classify`);
    expect(first.body.data.ai.sentiment).toBe('negative');
    // A model that leaves the mood out: taken as neutral.
    const second = await asAsha.post(`/api/emails/threads/${thread.id}/classify`);
    expect(second.body.data.ai.sentiment).toBe('neutral');
  });
});

describe('a mail of ours without an answer', () => {
  it('is brought up after 3 and after 7 days, once each, and shows under "follow-up due"', async () => {
    await asAsha
      .post('/api/emails/send')
      .send({ to: [CUSTOMER], subject: 'Our offer', text: 'Please find our offer.' });
    const thread = await EmailThread.findOne().lean();
    const sentAt = thread.lastMessageAt.getTime();
    const day = 24 * 3600 * 1000;
    const followUps = () => Notification.find({ type: 'email_follow_up' }).sort({ _id: 1 }).lean();

    expect(await runFollowUpReminders(new Date(sentAt + 2 * day))).toEqual({ told: 0 });
    expect(await runFollowUpReminders(new Date(sentAt + 3.5 * day))).toEqual({ told: 1 });
    expect(await runFollowUpReminders(new Date(sentAt + 3.6 * day))).toEqual({ told: 0 });
    expect(await runFollowUpReminders(new Date(sentAt + 5 * day))).toEqual({ told: 0 });
    expect(await runFollowUpReminders(new Date(sentAt + 7.2 * day))).toEqual({ told: 1 });
    const told = await followUps();
    expect(told.map((item) => item.title)).toEqual([
      'No answer from Asha Verma for 3 days',
      'No answer from Asha Verma for 7 days',
    ]);
    expect(told[0].link).toBe(`/inbox?thread=${thread._id}`);

    expect(await threadsOf(asAsha, '?view=follow_up')).toHaveLength(0);
    await EmailThread.updateOne(
      { _id: thread._id },
      { $set: { lastMessageAt: new Date(Date.now() - 4 * day) } },
    );
    expect(await threadsOf(asAsha, '?view=follow_up')).toHaveLength(1);
    expect(await threadsOf(asCeo, '?view=follow_up')).toHaveLength(0); // only one's own mailbox

    // The customer answers: nothing more is due.
    deliver({
      from: CUSTOMER,
      subject: 'Re: Our offer',
      text: 'Thanks.',
      thread: thread.gmailThreadId,
    });
    await syncMailbox(asha._id);
    expect(await threadsOf(asAsha, '?view=follow_up')).toHaveLength(0);
  });
});

describe('what a person decides about a conversation', () => {
  it('a conversation is put on another company, or on nothing; its mails move on the timeline', async () => {
    deliver({ from: CUSTOMER, subject: 'Pilot', text: 'Hello', thread: 't1' });
    await syncMailbox(asha._id);
    const [thread] = await threadsOf(asAsha);
    const other = await asAsha.post('/api/accounts/quick-add').send({
      account: { name: 'Other Works' },
      contacts: [{ name: 'Someone Else', email: 'someone@other.example' }],
    });
    const otherId = other.body.data.account.id;
    const { Activity } = await import('../models/activity.model.js');
    const entries = () => Activity.find({ type: 'EMAIL' }).lean();
    expect(String((await entries())[0].accountId)).toBe(accountId);

    const link = (client, body) => client.patch(`/api/emails/threads/${thread.id}/link`).send(body);
    const moved = await link(asAsha, { accountId: otherId });
    expect(moved.status).toBe(200);
    expect(moved.body.data).toMatchObject({
      account: { name: 'Other Works' },
      contact: null,
      lead: null,
    });
    expect((await entries()).map((entry) => String(entry.accountId))).toEqual([otherId]);

    // On nothing: only its owner sees it, and it leaves the timelines.
    expect((await link(asAsha, {})).body.data.account).toBeNull();
    expect(await entries()).toHaveLength(0);
    expect((await asCeo.get(`/api/emails/threads/${thread.id}`)).status).toBe(404);

    // Back on the first company and its person: the entry is there again.
    const back = await link(asAsha, { accountId, contactId });
    expect(back.body.data).toMatchObject({
      account: { name: 'Bharat Forge' },
      contact: { name: 'Asha Verma' },
    });
    expect((await entries()).map((entry) => entry.title)).toEqual(['Email from Asha Verma: Pilot']);

    // A person of another company is refused; somebody who cannot see it gets "not found".
    const stranger = String((await Contact.findOne({ email: 'someone@other.example' }).lean())._id);
    expect((await link(asAsha, { accountId, contactId: stranger })).status).toBe(400);
    expect((await link(asOther, { accountId })).status).toBe(404);
  });

  it('a sender who is not in the CRM is added, and only then is their mail brought in', async () => {
    deliver({
      from: 'Vikram Rao <vikram@newfoundry.example>',
      subject: 'Enquiry',
      text: 'We need OEE.',
    });
    await syncMailbox(asha._id);
    expect(await Email.countDocuments()).toBe(0); // the rule of the sync

    const brought = await asAsha.post('/api/emails/bring-in').send({
      email: 'Vikram@NewFoundry.example',
      contactName: 'Vikram Rao',
      accountName: 'New Foundry',
      leadName: 'OEE enquiry',
    });
    expect(brought.status).toBe(200);
    expect(brought.body.data).toMatchObject({ kept: 1 });
    expect(brought.body.data.leadId).toBeTruthy();
    const [thread] = await threadsOf(asAsha);
    expect(thread).toMatchObject({
      subject: 'Enquiry',
      account: { name: 'New Foundry' },
      contact: { name: 'Vikram Rao' },
      lead: { name: 'OEE enquiry' },
    });

    const again = { email: 'vikram@newfoundry.example', contactName: 'V', accountName: 'X' };
    expect((await asAsha.post('/api/emails/bring-in').send(again)).status).toBe(409);
    // Neither a company nor a new name; and a person without a mailbox.
    expect(
      (await asAsha.post('/api/emails/bring-in').send({ email: 'a@b.example', contactName: 'A' }))
        .status,
    ).toBe(400);
    expect(
      (
        await asCeo
          .post('/api/emails/bring-in')
          .send({ email: 'a@b.example', contactName: 'A', accountName: 'B' })
      ).status,
    ).toBe(409);
  });

  it('mail that was kept with file names only gets its files with a later reading', async () => {
    deliver({
      from: CUSTOMER,
      subject: 'Drawing',
      thread: 't1',
      files: [{ filename: 'press line.pdf', mimeType: 'application/pdf', content: DRAWING }],
    });
    await syncMailbox(asha._id);
    // As it was before files were copied: the name, no address.
    await Email.updateOne({}, { $unset: { 'attachments.0.url': '' } });
    stored.clear();

    await syncMailbox(asha._id);
    const email = await Email.findOne().lean();
    expect(email.attachments[0].url).toContain(`emails/${email._id}/1-press line.pdf`);
    expect(email.filesCheckedAt).toBeInstanceOf(Date);
    expect(stored.size).toBe(1);
  });

  it('my signature is kept with my connection', async () => {
    const saved = await asAsha
      .patch('/api/integrations/google/signature')
      .send({ signature: 'Asha Agent\nSales, +91 90000 00000' });
    expect(saved.body.data.connection.signature).toBe('Asha Agent\nSales, +91 90000 00000');
    expect(
      (await asCeo.patch('/api/integrations/google/signature').send({ signature: 'x' })).status,
    ).toBe(409); // no connection
  });
});

describe('the documents library', () => {
  const upload = (client, fields = {}) => {
    let call = client.post('/api/documents');
    for (const [key, value] of Object.entries(fields)) call = call.field(key, value);
    return call.attach('file', Buffer.from('%PDF brochure'), {
      filename: 'brochure.pdf',
      contentType: 'application/pdf',
    });
  };
  const browse = async (client, query = '') =>
    (await client.get(`/api/documents${query}`)).body.data;

  it('one library for everyone, in folders the team makes itself', async () => {
    // A sales agent looks and sends; adding and arranging is for the manager line (by the roles).
    expect((await upload(asAsha)).status).toBe(403);
    expect((await asAsha.post('/api/documents/folders').send({ name: 'Mine' })).status).toBe(403);

    const offers = (await asCeo.post('/api/documents/folders').send({ name: 'Offers' })).body.data;
    const year = (
      await asCeo.post('/api/documents/folders').send({ name: '2026', parentId: offers.id })
    ).body.data;
    expect((await asCeo.post('/api/documents/folders').send({ name: 'Offers' })).status).toBe(409);
    expect((await asCeo.post('/api/documents/folders').send({ name: ' ' })).status).toBe(400);

    const atTop = await upload(asCeo, { name: 'Company brochure' });
    expect(atTop.status).toBe(201);
    expect(atTop.body.data).toMatchObject({
      name: 'Company brochure',
      filename: 'brochure.pdf',
      folderId: null,
      uploadedBy: 'Kunal CEO',
    });
    expect(atTop.body.data.link).toContain('X-Amz-Signature');
    const inYear = await upload(asCeo, { folderId: year.id, name: 'Offer for presses' });
    expect(inYear.body.data.folderId).toBe(year.id);

    // Everyone with the permission sees the same library, whatever their customers are.
    const top = await browse(asOther);
    expect(top.path).toEqual([]);
    expect(top.folders.map((folder) => folder.name)).toEqual(['Offers']);
    expect(top.documents.map((item) => item.name)).toEqual(['Company brochure']);
    const deep = await browse(asAsha, `?folderId=${year.id}`);
    expect(deep.path.map((step) => step.name)).toEqual(['Offers', '2026']);
    expect(deep.documents.map((item) => item.name)).toEqual(['Offer for presses']);
    expect((await browse(asAsha, `?folderId=${offers.id}`)).folders).toMatchObject([
      { name: '2026', documentCount: 1 },
    ]);
    // A search looks through every folder.
    expect((await browse(asAsha, '?search=offer')).documents.map((item) => item.name)).toEqual([
      'Offer for presses',
    ]);
    expect((await asCeo.get('/api/documents/folders')).body.data.map((item) => item.path)).toEqual([
      'Offers',
      'Offers / 2026',
    ]);

    // Rename and move; a folder with something in it stays.
    const moved = await asCeo
      .patch(`/api/documents/${atTop.body.data.id}`)
      .send({ name: 'Brochure 2026', folderId: offers.id });
    expect(moved.body.data).toMatchObject({ name: 'Brochure 2026', folderId: offers.id });
    expect(
      (await asAsha.patch(`/api/documents/${atTop.body.data.id}`).send({ name: 'x' })).status,
    ).toBe(403);
    expect((await asCeo.delete(`/api/documents/folders/${year.id}`)).status).toBe(409);
    expect((await asCeo.delete(`/api/documents/${inYear.body.data.id}`)).status).toBe(200);
    expect((await asCeo.delete(`/api/documents/folders/${year.id}`)).status).toBe(200);
    expect(
      (await asCeo.patch(`/api/documents/folders/${offers.id}`).send({ name: 'Brochures' })).body
        .data.name,
    ).toBe('Brochures');
  });

  it('a document goes out with a mail to any customer; a deleted one does not', async () => {
    const made = await upload(asCeo, { name: 'Company brochure' });
    const send = () =>
      asAsha.post('/api/emails/send').send({
        to: [CUSTOMER],
        subject: 'Our brochure',
        text: 'Please find our brochure.',
        attachments: [{ url: made.body.data.url }],
      });
    expect((await send()).status).toBe(200);
    expect(mailbox.lastSent.files).toEqual([
      {
        filename: 'brochure.pdf',
        mimeType: 'application/pdf',
        content: Buffer.from('%PDF brochure'),
      },
    ]);
    expect((await asCeo.delete(`/api/documents/${made.body.data.id}`)).status).toBe(200);
    expect((await send()).status).toBe(400);
  });
});

describe('a mail as its sender laid it out', () => {
  it('the HTML form is kept next to the plain text', async () => {
    deliver({
      from: CUSTOMER,
      subject: 'Offer',
      text: 'Hello Asha',
      html: '<p>Hello <b>Asha</b></p><script>alert(1)</script>',
    });
    deliver({ from: CUSTOMER, subject: 'Plain', text: 'Only text' });
    await syncMailbox(asha._id);
    const threads = await threadsOf(asAsha);
    const byHtml = async (subject) =>
      (await detailOf(asAsha, threads.find((thread) => thread.subject === subject).id)).messages[0];
    // Kept as received: the screen cleans it and shows it in a closed frame.
    expect(await byHtml('Offer')).toMatchObject({
      text: 'Hello Asha',
      html: '<p>Hello <b>Asha</b></p><script>alert(1)</script>',
    });
    expect((await byHtml('Plain')).html).toBeNull();
  });
});

describe('push from Gmail', () => {
  it('a mailbox is watched and the watch is renewed; a push reads that mailbox', async () => {
    const { UserGoogleConnection } = await import('../models/userGoogleConnection.model.js');
    const { WebhookEvent } = await import('../models/webhookEvent.model.js');
    const { processWebhookEvent } = await import('../services/webhooks.service.js');
    const { renewGmailWatches } = await import('../services/emailPush.service.js');

    expect(await renewGmailWatches()).toEqual({ watched: 1 });
    expect(mailbox.watchedTopic).toBe('projects/test-project/topics/gmail-push');
    const connection = await UserGoogleConnection.findOne().lean();
    expect(connection.gmail.watchExpiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86400000);
    expect(await renewGmailWatches()).toEqual({ watched: 0 }); // nothing is due
    // Two days before it runs out, it is renewed.
    const later = new Date(connection.gmail.watchExpiresAt.getTime() - 86400000);
    expect(await renewGmailWatches(later)).toEqual({ watched: 1 });

    // Google says the mailbox changed. The message holds no mail.
    await syncMailbox(asha._id);
    deliver({ from: CUSTOMER, subject: 'Pushed', text: 'Arrived just now' });
    const push = (token) =>
      request(app)
        .post(`/api/webhooks/google/gmail?token=${token}`)
        .send({
          message: {
            messageId: 'pubsub-1',
            data: Buffer.from(JSON.stringify({ emailAddress: OWN, historyId: 999 })).toString(
              'base64',
            ),
          },
          subscription: 'projects/test-project/subscriptions/gmail-push',
        });
    expect((await push('a-wrong-token-a-wrong-token-1234')).status).toBe(401);
    expect(await Email.countDocuments()).toBe(0);
    expect((await push(PUSH_TOKEN)).status).toBe(200);
    expect((await push(PUSH_TOKEN)).status).toBe(200); // the same message again: stored once
    const events = await WebhookEvent.find({ provider: 'gmail_push', signatureValid: true }).lean();
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ emailAddress: OWN, historyId: '999' });
    await processWebhookEvent(events[0]._id);
    expect((await Email.findOne().lean()).subject).toBe('Pushed');
  });
});

describe('bulk mail', () => {
  const CEO_MAIL = 'ceo@engenx.in';
  const DAY = 24 * 3600 * 1000;
  let bundleId;
  let ceoId;

  /** Run a sending to its end; what happened at each step. */
  async function runToEnd(campaignId) {
    const steps = [];
    for (let guard = 0; guard < 30; guard += 1) {
      const step = await runCampaignStep(campaignId);
      steps.push(step);
      if (['finished', 'paused', 'idle'].includes(step)) break;
    }
    return steps;
  }
  const recipientsOf = async (id) =>
    (await asCeo.get(`/api/campaigns/${id}/recipients?pageSize=100`)).body.data;
  const byName = (rows) => Object.fromEntries(rows.map((row) => [row.name, row]));
  const newSending = (extra = {}) =>
    asCeo.post('/api/campaigns').send({
      name: 'October round',
      channel: 'email',
      bundleId,
      gapSeconds: 5,
      writeMode: 'ai',
      brief: 'Tell them about our new OEE dashboard and offer a 30 minute demo.',
      ...extra,
    });

  beforeEach(async () => {
    const ceo = await loadRequestUser((await User.findOne({ email: CEO_MAIL }))._id);
    ceoId = String(ceo._id);
    await completeConnect(ceo, {
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresInSec: 3600,
      scopes: [
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/calendar.events',
      ],
      googleEmail: CEO_MAIL,
      hostedDomain: 'engenx.in',
    });
    const made = [];
    for (const [company, person, email, phone] of [
      ['Shakti Works', 'Ravi Kumar', 'ravi@shakti.example'],
      ['Nova Cast', 'Nina Shah', 'nina@nova.example'],
      ['Tara Steel', 'Tara Rao', 'tara@tarasteel.example'],
      ['Phone Only', 'Pat Phone', undefined, '+919811112222'],
    ]) {
      const created = await asCeo.post('/api/accounts/quick-add').send({
        account: { name: company },
        contacts: [
          { name: person, ...(email ? { email } : {}), ...(phone ? { phone_number: phone } : {}) },
        ],
      });
      made.push(created.body.data.account.id);
    }
    bundleId = (
      await asCeo
        .post('/api/bundles')
        .send({ name: 'Everyone', accountIds: [accountId, ...made], includeCompany: false })
    ).body.data.id;

    // Asha Verma: the CEO wrote five days ago, no answer.
    await asCeo
      .post('/api/emails/send')
      .send({ to: [CUSTOMER], subject: 'Our offer', text: 'Hello Asha' });
    await EmailThread.updateOne(
      { participants: CUSTOMER },
      { $set: { lastMessageAt: new Date(Date.now() - 5 * DAY) } },
    );
    // Tara Rao: the CEO wrote yesterday.
    await asCeo
      .post('/api/emails/send')
      .send({ to: ['tara@tarasteel.example'], subject: 'Hello Tara', text: 'Hello' });
    await EmailThread.updateOne(
      { participants: 'tara@tarasteel.example' },
      { $set: { lastMessageAt: new Date(Date.now() - 1 * DAY) } },
    );
    // Ravi Kumar: he wrote to the CEO last.
    deliver({ from: 'ravi@shakti.example', to: [CEO_MAIL], subject: 'Question', text: 'Price?' });
    await syncMailbox(ceoId);
    aiRequests = [];
  });

  it('reminds in the old conversation, writes a first mail, and skips with a reason', async () => {
    const sending = await newSending();
    expect(sending.status).toBe(201);
    expect(sending.body.data).toMatchObject({
      status: 'draft',
      sender: 'Kunal CEO',
      bundleName: 'Everyone',
      counts: { total: 5, pending: 4, sent: 0, failed: 0, skipped: 1 },
    });
    const id = sending.body.data.id;
    const before = mailbox.messages.length;
    expect(await runCampaignStep(id)).toBe('idle'); // a draft sends nothing

    aiAnswers = [
      { subject: 'A', body: 'Dear reader,\n\nFirst text.\n\nRegards,\nKunal CEO' },
      { subject: 'B', body: 'Dear reader,\n\nSecond text.\n\nRegards,\nKunal CEO' },
    ];
    expect((await asCeo.post(`/api/campaigns/${id}/start`)).body.data.status).toBe('running');
    const steps = await runToEnd(id);
    expect(steps.at(-1)).toBe('finished');
    expect(steps.filter((step) => step === 'sent')).toHaveLength(2);

    const rows = byName(await recipientsOf(id));
    expect(rows['Asha Verma']).toMatchObject({
      status: 'sent',
      action: 'reminder',
      subject: 'Our offer',
    });
    expect(rows['Nina Shah']).toMatchObject({ status: 'sent', action: 'new' });
    expect(rows['Ravi Kumar'].status).toBe('skipped');
    expect(rows['Ravi Kumar'].reason).toMatch(/They wrote to you last .* answer them yourself/);
    expect(rows['Tara Rao'].status).toBe('skipped');
    expect(rows['Tara Rao'].reason).toMatch(/You wrote to them 1 day ago .* only after 3 days/);
    expect(rows['Pat Phone']).toMatchObject({
      status: 'skipped',
      reason: 'No email address is saved.',
    });

    // Two mails went out, and the reminder went into the old conversation.
    expect(mailbox.messages).toHaveLength(before + 2);
    const ashaThread = await EmailThread.findOne({ participants: CUSTOMER }).lean();
    expect(ashaThread.messageCount).toBe(2);
    expect(await EmailThread.countDocuments({ participants: CUSTOMER })).toBe(1);
    // The AI got the reminder's conversation, and the first mail's company.
    const modes = aiRequests.map((item) => item.mode).sort();
    expect(modes).toEqual(['follow_up', 'new']);
    expect(aiRequests.find((item) => item.mode === 'follow_up').instruction).toContain('reminder');
    expect(aiRequests.find((item) => item.mode === 'new').customer.company).toBe('Nova Cast');

    const done = (await asCeo.get(`/api/campaigns/${id}`)).body.data;
    expect(done).toMatchObject({
      status: 'finished',
      counts: { total: 5, pending: 0, sent: 2, failed: 0, skipped: 3 },
    });
    const told = await Notification.find({ type: 'bulk_finished' }).lean();
    expect(told.map((item) => [item.title, item.body])).toEqual([
      ['Bulk sending finished: October round', '2 sent, 0 failed, 3 skipped'],
    ]);
    // Running it again sends nothing more.
    expect(await runCampaignStep(id)).toBe('idle');
    expect(mailbox.messages).toHaveLength(before + 2);

    // The people who did not get it become a new bundle.
    const rest = await asCeo.post(`/api/campaigns/${id}/bundle`).send({ name: 'Not reached' });
    expect(rest.status).toBe(201);
    expect(rest.body.data).toMatchObject({ name: 'Not reached', memberCount: 3 });
    const members = (await asCeo.get(`/api/bundles/${rest.body.data.id}`)).body.data.members;
    expect(members.map((item) => item.name).sort()).toEqual([
      'Pat Phone',
      'Ravi Kumar',
      'Tara Rao',
    ]);
  });

  it('never sends a mail in which the AI left something to fill in', async () => {
    const id = (await newSending()).body.data.id;
    const before = mailbox.messages.length;
    aiAnswers = [
      { subject: 'A', body: 'Dear Asha,\n\nThe demo is on [date].\n\nRegards,\nKunal CEO' },
      { subject: 'B', body: 'Dear Nina,\n\nA demo takes 30 minutes.\n\nRegards,\nKunal CEO' },
    ];
    await asCeo.post(`/api/campaigns/${id}/start`);
    await runToEnd(id);
    const rows = await recipientsOf(id);
    const failed = rows.filter((row) => row.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toContain('The AI left something to fill in ([date])');
    expect(failed[0].body).toContain('[date]'); // kept, so a person can see what it wrote
    expect(mailbox.messages).toHaveLength(before + 1);
  });

  it('a fixed text is filled in for each reader; pause, go on, cancel; only its maker runs it', async () => {
    const sending = await newSending({
      writeMode: 'fixed',
      brief: undefined,
      subject: 'A demo for {{company}}',
      body: 'Dear {{name}},\n\nMay we show you our dashboard?\n\nRegards,\nKunal',
      minDaysBeforeReminder: 0,
    });
    const id = sending.body.data.id;
    // Not the maker (and without bulk sending at all).
    expect((await asAsha.post(`/api/campaigns/${id}/start`)).status).toBe(403);
    expect((await newSending({ writeMode: 'fixed' })).status).toBe(400); // no text
    expect((await newSending({ gapSeconds: 1 })).status).toBe(400);

    await asCeo.post(`/api/campaigns/${id}/start`);
    aiAnswers = [{ subject: 'x', body: 'Dear Asha,\n\nA short reminder.\n\nRegards,\nKunal CEO' }];
    const first = await runCampaignStep(id);
    expect(['sent', 'skipped']).toContain(first);
    const paused = await asCeo.post(`/api/campaigns/${id}/stop`).send({ action: 'pause' });
    expect(paused.body.data).toMatchObject({
      status: 'paused',
      pauseReason: 'Paused by Kunal CEO.',
    });
    expect(await runCampaignStep(id)).toBe('idle');

    await asCeo.post(`/api/campaigns/${id}/start`); // go on
    aiAnswers.push({
      subject: 'x',
      body: 'Dear reader,\n\nA short reminder.\n\nRegards,\nKunal CEO',
    });
    await runToEnd(id);
    const rows = byName(await recipientsOf(id));
    expect(rows['Nina Shah']).toMatchObject({
      status: 'sent',
      action: 'new',
      subject: 'A demo for Nova Cast',
    });
    expect(rows['Nina Shah'].body).toContain('Dear Nina Shah,');
    // With "0 days", the person written to yesterday gets a reminder too.
    expect(rows['Tara Rao']).toMatchObject({ status: 'sent', action: 'reminder' });
    expect((await asCeo.post(`/api/campaigns/${id}/stop`).send({ action: 'cancel' })).status).toBe(
      409,
    ); // it is over

    // A draft can be cancelled; then it never starts.
    const other = (await newSending()).body.data.id;
    expect(
      (await asCeo.post(`/api/campaigns/${other}/stop`).send({ action: 'cancel' })).body.data
        .status,
    ).toBe('cancelled');
    expect((await asCeo.post(`/api/campaigns/${other}/start`)).status).toBe(409);
  });

  it('shows before starting what it would do, with one mail as the AI would write it', async () => {
    const id = (await newSending()).body.data.id;
    const before = mailbox.messages.length;
    aiAnswers = [
      { subject: 'Our offer', body: 'Dear Asha,\n\nA reminder.\n\nRegards,\nKunal CEO' },
    ];
    const preview = (await asCeo.post(`/api/campaigns/${id}/preview`)).body.data;
    expect(preview.plan.map((item) => item.will).sort()).toEqual([
      'new',
      'reminder',
      'skip',
      'skip',
    ]);
    expect(preview.sample.body).toContain('Regards');
    expect(mailbox.messages).toHaveLength(before); // nothing was sent
  });

  // Only Nina Shah can be written to: everyone else is skipped by the mail rules.
  const onlyNina = {
    writeMode: 'fixed',
    brief: undefined,
    subject: 'A demo',
    body: 'Dear {{name}},\n\nMay we show you our dashboard?',
    minDaysBeforeReminder: 60,
  };

  it('ends a mail with a link to stop such mails; whoever used it is skipped from then on', async () => {
    const id = (await newSending(onlyNina)).body.data.id;
    // A second one, made before she says no.
    const madeBefore = (await newSending({ ...onlyNina, name: 'Made before' })).body.data.id;
    await asCeo.post(`/api/campaigns/${id}/start`);
    await runToEnd(id);
    const nina = byName(await recipientsOf(id))['Nina Shah'];
    expect(nina.status).toBe('sent');
    expect(nina.body).toContain('If you do not want mails like this from us any more');
    const token = /\/stop-mail\/(\S+)/.exec(nina.body)[1];
    // The line is in the mail that went out, not only in the list.
    const kept = await Email.findOne({ direction: 'outbound' }).sort({ _id: -1 }).lean();
    expect(kept.text).toContain(`/stop-mail/${token}`);

    // The page behind the link needs no sign-in, and works only for a genuine link.
    const page = await request(app).get(`/api/public/stop-mail/${token}`);
    expect(page.body.data).toEqual({ email: 'nina@nova.example', isStopped: false });
    const forged = `${Buffer.from('ravi@shakti.example').toString('base64url')}.${token.split('.')[1]}`;
    expect((await request(app).get(`/api/public/stop-mail/${forged}`)).status).toBe(404);
    expect((await request(app).post(`/api/public/stop-mail/${forged}`)).status).toBe(404);
    expect((await request(app).get('/api/public/stop-mail/nonsense')).status).toBe(400);

    const stopped = await request(app).post(`/api/public/stop-mail/${token}`);
    expect(stopped.body.data).toEqual({ email: 'nina@nova.example', isStopped: true });
    await request(app).post(`/api/public/stop-mail/${token}`); // twice changes nothing
    const list = (await asCeo.get('/api/campaigns/opt-outs')).body.data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      channel: 'email',
      address: 'nina@nova.example',
      source: 'link',
      addedBy: null,
    });

    // A sending made earlier looks again at the moment of sending.
    const before = mailbox.messages.length;
    await asCeo.post(`/api/campaigns/${madeBefore}/start`);
    await runToEnd(madeBefore);
    expect(mailbox.messages).toHaveLength(before);
    expect(byName(await recipientsOf(madeBefore))['Nina Shah']).toMatchObject({
      status: 'skipped',
      reason: expect.stringContaining('asked for no bulk mails'),
    });
    // A new sending says so right away.
    const next = (await newSending(onlyNina)).body.data;
    expect(next.counts).toMatchObject({ total: 5, pending: 3, skipped: 2 });
    // A single, normal mail to her still goes out.
    const single = await asCeo
      .post('/api/emails/send')
      .send({ to: ['nina@nova.example'], subject: 'About your question', text: 'Hello Nina' });
    expect(single.status).toBe(200);
  });

  it('the list of who gets no bulk messages is kept by the people who send in bulk', async () => {
    const added = await asCeo
      .post('/api/campaigns/opt-outs')
      .send({ channel: 'email', address: ' Nina@Nova.example ', note: 'Asked on the phone' });
    expect(added.status).toBe(201);
    expect(added.body.data).toEqual({ channel: 'email', address: 'nina@nova.example' });
    await asCeo
      .post('/api/campaigns/opt-outs')
      .send({ channel: 'whatsapp', address: '98111 12222' });
    expect(
      (await asCeo.post('/api/campaigns/opt-outs').send({ channel: 'email', address: 'not mail' }))
        .status,
    ).toBe(400);
    expect(
      (await asCeo.post('/api/campaigns/opt-outs').send({ channel: 'whatsapp', address: 'abc' }))
        .status,
    ).toBe(400);
    const list = (await asCeo.get('/api/campaigns/opt-outs')).body.data;
    expect(list.map((row) => [row.channel, row.address, row.source, row.addedBy]).sort()).toEqual([
      ['email', 'nina@nova.example', 'person', 'Kunal CEO'],
      ['whatsapp', '+919811112222', 'person', 'Kunal CEO'],
    ]);
    expect((await asCeo.get('/api/campaigns/opt-outs?search=nova')).body.data).toHaveLength(1);
    expect((await asCeo.get('/api/campaigns/opt-outs?channel=whatsapp')).body.data).toHaveLength(1);
    // A person without bulk sending does not see or change it.
    expect((await asAsha.get('/api/campaigns/opt-outs')).status).toBe(403);

    // Taken off the list, she gets the mail again; the maker left the last line out.
    const id = (await newSending({ ...onlyNina, addStopLine: false })).body.data.id;
    expect(byName(await recipientsOf(id))['Nina Shah'].status).toBe('skipped');
    const row = list.find((item) => item.channel === 'email');
    expect((await asCeo.delete(`/api/campaigns/opt-outs/${row.id}`)).status).toBe(200);
    expect((await asCeo.delete(`/api/campaigns/opt-outs/${row.id}`)).status).toBe(404);
    const again = (await newSending({ ...onlyNina, addStopLine: false })).body.data;
    expect(again.addStopLine).toBe(false);
    await asCeo.post(`/api/campaigns/${again.id}/start`);
    await runToEnd(again.id);
    const nina = byName(await recipientsOf(again.id))['Nina Shah'];
    expect(nina.status).toBe('sent');
    expect(nina.body).toBe('Dear Nina Shah,\n\nMay we show you our dashboard?');
  });

  it('is planned for a later moment and then starts by itself', async () => {
    const { sweepCampaigns } = await import('../services/campaigns.service.js');
    const HOUR = 3600 * 1000;
    const id = (await newSending(onlyNina)).body.data.id;
    const start = (body) => asCeo.post(`/api/campaigns/${id}/start`).send(body);
    const statusOf = async () => (await asCeo.get(`/api/campaigns/${id}`)).body.data.status;
    const before = mailbox.messages.length;

    expect((await start({ at: new Date(Date.now() - HOUR) })).status).toBe(400);
    expect((await start({ at: new Date(Date.now() + 90 * 24 * HOUR) })).status).toBe(400);
    expect((await start({ at: 'tomorrow morning' })).status).toBe(400);
    const at = new Date(Date.now() + 2 * HOUR);
    const planned = await start({ at });
    expect(planned.body.data).toMatchObject({ status: 'scheduled', scheduledAt: at.toISOString() });
    // Nothing goes out before its time.
    expect(await runCampaignStep(id)).toBe('idle');
    expect((await sweepCampaigns()).started).toBe(0);
    expect(await statusOf()).toBe('scheduled');
    expect(mailbox.messages).toHaveLength(before);

    // The plan is taken off (a draft again), and made again for another moment.
    const draft = await asCeo.post(`/api/campaigns/${id}/stop`).send({ action: 'unschedule' });
    expect(draft.body.data).toMatchObject({ status: 'draft', scheduledAt: null });
    expect(
      (await asCeo.post(`/api/campaigns/${id}/stop`).send({ action: 'unschedule' })).status,
    ).toBe(409);
    const later = new Date(Date.now() + 3 * HOUR);
    await start({ at });
    expect((await start({ at: later })).body.data.scheduledAt).toBe(later.toISOString());
    expect((await sweepCampaigns(new Date(at.getTime() + 1000))).started).toBe(0);

    // Its moment comes.
    expect((await sweepCampaigns(new Date(later.getTime() + 1000))).started).toBe(1);
    expect(await statusOf()).toBe('running');
    expect((await runToEnd(id)).at(-1)).toBe('finished');
    expect(byName(await recipientsOf(id))['Nina Shah'].status).toBe('sent');
    expect(mailbox.messages).toHaveLength(before + 1);
    // Once it ran, it cannot be planned.
    expect((await start({ at: new Date(Date.now() + HOUR) })).status).toBe(409);

    // A planned one can be started at once, or cancelled.
    const second = (await newSending({ ...onlyNina, name: 'Second' })).body.data.id;
    await asCeo.post(`/api/campaigns/${second}/start`).send({ at });
    expect((await asCeo.post(`/api/campaigns/${second}/start`)).body.data).toMatchObject({
      status: 'running',
      scheduledAt: null,
    });
    const third = (await newSending({ ...onlyNina, name: 'Third' })).body.data.id;
    await asCeo.post(`/api/campaigns/${third}/start`).send({ at });
    expect(
      (await asCeo.post(`/api/campaigns/${third}/stop`).send({ action: 'cancel' })).body.data
        .status,
    ).toBe('cancelled');
    expect((await sweepCampaigns(new Date(later.getTime() + 1000))).started).toBe(0);
  });

  it('a planned sending whose mailbox is gone at its moment waits, and its maker is told', async () => {
    const { sweepCampaigns } = await import('../services/campaigns.service.js');
    const { UserGoogleConnection } = await import('../models/userGoogleConnection.model.js');
    const id = (await newSending(onlyNina)).body.data.id;
    const at = new Date(Date.now() + 3600 * 1000);
    await asCeo.post(`/api/campaigns/${id}/start`).send({ at });
    await UserGoogleConnection.deleteMany({ userId: ceoId });
    const before = mailbox.messages.length;

    await sweepCampaigns(new Date(at.getTime() + 1000));
    const waiting = (await asCeo.get(`/api/campaigns/${id}`)).body.data;
    expect(waiting.status).toBe('paused');
    expect(waiting.pauseReason).toMatch(
      /^It could not start at the planned time\. Connect your Gmail/,
    );
    expect(await runCampaignStep(id)).toBe('idle');
    expect(mailbox.messages).toHaveLength(before);
    const told = await Notification.find({ type: 'bulk_finished' }).lean();
    expect(told.map((item) => item.title)).toEqual(['Bulk sending did not start: October round']);
  });
});
