import { draftReply, writeEmail } from '../ai/tasks/emailTasks.js';
import { JOB_NAMES } from '../constants/jobNames.js';
import { sendMessage } from '../integrations/google/gmail.js';
import { logger } from '../infra/logger.js';
import { enqueue } from '../infra/queues.js';
import { writeAudit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { keyFromUrl, readObject } from '../infra/storage.js';
import { runListQuery } from '../lib/queryBuilder.js';
import { can, getScope } from '../lib/can.js';
import { MATCH_NOTHING, scopeFilter } from '../lib/scopeFilter.js';
import { Account } from '../models/account.model.js';
import { Contact } from '../models/contact.model.js';
import { Email, EmailThread } from '../models/email.model.js';
import { Opportunity } from '../models/opportunity.model.js';
import { PipelineStage } from '../models/pipelineStage.model.js';
import { User } from '../models/user.model.js';
import { loadAccountForAction } from './accounts.service.js';
import { findSendableDocument } from './documents.service.js';
import {
  MAX_SEND_BYTES,
  attachmentViews,
  keepUploadedFile,
  uploadPrefixOf,
} from './emailFiles.service.js';
import { classifyThread, keepMessage, syncMailbox } from './emailSync.service.js';
import { getCompanyMailbox, getGoogleAccessToken } from './googleConnection.service.js';

// Customer mail in the CRM: reading conversations, answering, and the AI's help. All mail
// comes from and goes out of ONE company mailbox (decision 0014). Bringing mail in is
// services/emailSync.service.js.
//
// WHO SEES WHAT (founder decision 2026-10-15): the CRM's own access rules. A conversation
// about a company or a lead is seen by everyone who may see that company or that lead (an
// agent: their own; a manager: their team's; the CEO: all). A conversation linked to nothing
// is seen only by someone who sees every company. Anyone who sees a conversation and may write
// mail can answer in it; the mail goes out from the company mailbox, and the CRM keeps who sent
// it.

const FEATURE = 'email';
const NOT_DELETED = { deletedAt: null };
const NOT_CONNECTED =
  'The company mailbox is not connected. Someone who manages the settings connects it under Mail and calendar.';
const ids = (rows) => rows.map((row) => row._id);

/** The conversations a person may see (a MongoDB filter). */
export async function visibleThreads(actor) {
  if (getScope(actor, FEATURE, 'view') === null) return MATCH_NOTHING;
  if (getScope(actor, 'accounts', 'view') === 'all') return {};
  const [accounts, leads] = await Promise.all([
    Account.find({ $and: [scopeFilter(actor, 'accounts'), NOT_DELETED] })
      .select('_id')
      .lean(),
    Opportunity.find({ $and: [scopeFilter(actor, 'opportunities'), NOT_DELETED] })
      .select('_id')
      .lean(),
  ]);
  return {
    $or: [{ accountId: { $in: ids(accounts) } }, { opportunityId: { $in: ids(leads) } }],
  };
}

/** Conversations about companies and leads I own: "mine" in the Inbox. */
async function myThreads(actor) {
  const [accounts, leads] = await Promise.all([
    Account.find({ ownerId: actor._id, ...NOT_DELETED })
      .select('_id')
      .lean(),
    Opportunity.find({ ownerId: actor._id, ...NOT_DELETED })
      .select('_id')
      .lean(),
  ]);
  return {
    $or: [{ accountId: { $in: ids(accounts) } }, { opportunityId: { $in: ids(leads) } }],
  };
}

export async function loadThreadForViewer(actor, threadId) {
  const thread = await EmailThread.findOne({
    $and: [{ _id: threadId }, await visibleThreads(actor)],
  }).lean();
  if (!thread) throw notFound('Conversation not found');
  return thread;
}

async function namesOf(threads) {
  const ids = (field) => [
    ...new Set(
      threads
        .map((thread) => thread[field])
        .filter(Boolean)
        .map(String),
    ),
  ];
  const [users, contacts, accounts, leads] = await Promise.all([
    User.find({ _id: { $in: ids('userId') } })
      .select('name')
      .lean(),
    Contact.find({ _id: { $in: ids('contactId') } })
      .select('name email')
      .lean(),
    Account.find({ _id: { $in: ids('accountId') } })
      .select('name')
      .lean(),
    Opportunity.find({ _id: { $in: ids('opportunityId') } })
      .select('name')
      .lean(),
  ]);
  const map = (list) => new Map(list.map((item) => [String(item._id), item]));
  return { users: map(users), contacts: map(contacts), accounts: map(accounts), leads: map(leads) };
}

function toThreadView(thread, names, actor) {
  const named = (list, id) => {
    const item = id && list.get(String(id));
    return item ? { id: String(item._id), name: item.name } : null;
  };
  return {
    id: String(thread._id),
    subject: thread.subject ?? '(no subject)',
    snippet: thread.snippet ?? '',
    messageCount: thread.messageCount,
    lastMessageAt: thread.lastMessageAt,
    // The customer wrote last: an answer may be due.
    isWaitingForUs: thread.lastDirection === 'inbound',
    participants: thread.participants,
    owner: named(names.users, thread.userId),
    contact: named(names.contacts, thread.contactId),
    account: named(names.accounts, thread.accountId),
    lead: named(names.leads, thread.opportunityId),
    ai: thread.ai?.category
      ? {
          category: thread.ai.category,
          needsReply: Boolean(thread.ai.needsReply),
          summary: thread.ai.summary,
          suggestedAction: thread.ai.suggestedAction || null,
          sentiment: thread.ai.sentiment ?? 'neutral',
          at: thread.ai.at,
        }
      : null,
    // The answer goes out from the company mailbox.
    permissions: { canReply: can(actor, 'create', { feature: FEATURE }) },
  };
}

/**
 * Conversations, newest first.
 * @param {{ view?: 'all' | 'waiting' | 'mine', search?: string, accountId?: string,
 *           opportunityId?: string, page: number, pageSize: number }} query  Validated
 */
export async function listThreads(actor, query) {
  const escaped = query.search?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const filter = {
    $and: [
      await visibleThreads(actor),
      query.view === 'waiting' ? { lastDirection: 'inbound' } : {},
      query.view === 'mine' ? await myThreads(actor) : {},
      query.view === 'follow_up'
        ? {
            $and: [
              await myThreads(actor),
              {
                lastDirection: 'outbound',
                lastMessageAt: { $lte: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
              },
            ],
          }
        : {},
      query.accountId ? { accountId: query.accountId } : {},
      query.opportunityId ? { opportunityId: query.opportunityId } : {},
      query.contactId ? { contactId: query.contactId } : {},
      escaped
        ? {
            $or: [
              { subject: new RegExp(escaped, 'i') },
              { participants: new RegExp(escaped, 'i') },
            ],
          }
        : {},
    ],
  };
  const { rows, pagination } = await runListQuery(EmailThread, {
    filter,
    sort: { lastMessageAt: -1, _id: -1 },
    page: query.page,
    pageSize: query.pageSize,
  });
  const names = await namesOf(rows);
  return { items: rows.map((row) => toThreadView(row, names, actor)), pagination };
}

/** One conversation with its messages, oldest first. */
export async function getThread(actor, threadId) {
  const thread = await loadThreadForViewer(actor, threadId);
  const [names, emails] = await Promise.all([
    namesOf([thread]),
    Email.find({ threadId: thread._id }).sort({ sentAt: 1 }).lean(),
  ]);
  const files = await Promise.all(emails.map((email) => attachmentViews(email.attachments)));
  // Who of us sent each mail from the CRM (they all go out from the company mailbox).
  const senders = await User.find({
    _id: { $in: emails.map((email) => email.sentByUserId).filter(Boolean) },
  })
    .select('name')
    .lean();
  const senderName = new Map(senders.map((user) => [String(user._id), user.name]));
  return {
    ...toThreadView(thread, names, actor),
    messages: emails.map((email, index) => ({
      id: String(email._id),
      direction: email.direction,
      from: email.from,
      fromName: email.fromName ?? null,
      to: email.to,
      cc: email.cc,
      sentAt: email.sentAt,
      text: email.text ?? '',
      html: email.html ?? null,
      sentBy: email.sentByUserId ? (senderName.get(String(email.sentByUserId)) ?? null) : null,
      // Each with a link that opens for an hour.
      attachments: files[index],
    })),
  };
}

/** Keep a file I picked from my device, to send with my next mail. */
export function uploadAttachment(actor, file) {
  return keepUploadedFile(actor, file);
}

/**
 * The files that came or went with the mail of one company, newest first: to look at, and to
 * pick from when writing a mail.
 */
export async function listAccountFiles(actor, accountId) {
  const account = await loadAccountForAction(actor, accountId, 'view');
  const threads = await EmailThread.find({
    $and: [{ accountId: account._id }, await visibleThreads(actor)],
  })
    .select('_id subject')
    .lean();
  const subjects = new Map(threads.map((thread) => [String(thread._id), thread.subject]));
  const emails = await Email.find({
    threadId: { $in: threads.map((thread) => thread._id) },
    'attachments.url': { $exists: true },
  })
    .sort({ sentAt: -1 })
    .limit(100)
    .lean();
  const rows = [];
  for (const email of emails) {
    for (const file of await attachmentViews(email.attachments)) {
      if (!file.link) continue;
      rows.push({
        ...file,
        direction: email.direction,
        sentAt: email.sentAt,
        subject: subjects.get(String(email.threadId)) ?? '',
      });
    }
  }
  return rows;
}

/**
 * The files to send, as bytes. A file may be one I just picked from my device, or one that is
 * on a mail of a conversation I may see. Anything else is refused.
 * @param {{ url: string, filename?: string, mimeType?: string }[]} refs
 */
async function readAttachments(actor, refs = []) {
  const files = [];
  let total = 0;
  for (const ref of refs) {
    const key = keyFromUrl(ref.url);
    let meta = null;
    if (key?.startsWith(uploadPrefixOf(actor._id))) {
      meta = { filename: ref.filename ?? key.split('/').pop(), mimeType: ref.mimeType };
    } else if (key) {
      const email = await Email.findOne({ 'attachments.url': ref.url }).lean();
      const isVisible =
        email &&
        (await EmailThread.exists({
          $and: [{ _id: email.threadId }, await visibleThreads(actor)],
        }));
      if (isVisible) meta = email.attachments.find((file) => file.url === ref.url);
      // Or a document kept for a company the sender may see.
      if (!meta) meta = await findSendableDocument(actor, ref.url);
    }
    const content = meta ? await readObject(key) : null;
    if (!content) throw badRequest('One of the files could not be found. Attach it again.');
    total += content.length;
    if (total > MAX_SEND_BYTES) {
      throw badRequest('The files together are too large for one mail (about 17 MB).');
    }
    files.push({
      filename: String(meta.filename).slice(0, 200),
      mimeType: meta.mimeType || 'application/octet-stream',
      content,
    });
  }
  return files;
}

/** What the Inbox needs to know: is the company mailbox connected, when was it last read. */
export async function getMailboxStatus() {
  const connection = await getCompanyMailbox();
  return {
    isConnected: connection?.status === 'connected',
    needsReconnect: connection?.status === 'needs_reconnect',
    googleEmail: connection?.googleEmail ?? null,
    lastSyncAt: connection?.gmail?.lastSyncAt ?? null,
    lastError: connection?.lastError ?? null,
  };
}

/**
 * Bring the company mailbox up to date now. With a queue it runs in the background; without
 * one, here.
 * @returns {Promise<{ started: true }>}
 */
export async function requestSync() {
  const mailbox = await getCompanyMailbox();
  if (mailbox?.status !== 'connected') throw conflict(NOT_CONNECTED);
  try {
    await enqueue(
      'messaging',
      JOB_NAMES.emailSync,
      { userId: String(mailbox.userId) },
      { jobId: `email-sync-${mailbox.userId}-${Math.floor(Date.now() / 30_000)}` },
    );
  } catch {
    setImmediate(() =>
      syncMailbox().catch((error) => logger.error({ err: error }, 'Mail sync failed')),
    );
  }
  return { started: true };
}

/**
 * Send a mail from the company mailbox: an answer inside a conversation, or a new mail. The
 * CRM keeps who of us sent it.
 * @param {{ threadId?: string, to?: string[], cc?: string[], subject?: string, text: string,
 *           attachments?: { url: string, filename?: string, mimeType?: string }[] }} mail
 *        Validated. With threadId the recipients and the subject come from the conversation
 *        unless given.
 */
export async function sendEmail(actor, mail, context = {}) {
  const connection = await getCompanyMailbox();
  if (connection?.status !== 'connected') throw conflict(NOT_CONNECTED);
  const own = connection.googleEmail;

  let thread = null;
  let answered = null;
  if (mail.threadId) {
    thread = await loadThreadForViewer(actor, mail.threadId);
    // The newest message of the customer (or, failing that, the newest at all) is answered.
    const emails = await Email.find({ threadId: thread._id }).sort({ sentAt: -1 }).limit(10).lean();
    answered = emails.find((email) => email.direction === 'inbound') ?? emails[0] ?? null;
  }
  const to = (
    mail.to?.length
      ? mail.to
      : answered
        ? [answered.direction === 'inbound' ? answered.from : answered.to[0]]
        : []
  )
    .filter(Boolean)
    .map((address) => address.toLowerCase())
    .filter((address) => address !== own);
  if (to.length === 0) throw badRequest('Say who the mail goes to.', [{ field: 'to' }]);
  const base = thread?.subject ?? '';
  const subject =
    mail.subject?.trim() || (thread ? (/^re:/i.test(base) ? base : `Re: ${base}`) : '');
  if (!subject) throw badRequest('Write a subject.', [{ field: 'subject' }]);

  const attachments = await readAttachments(actor, mail.attachments);
  const token = await getGoogleAccessToken();
  const sent = await sendMessage(token, {
    attachments,
    from: own,
    to,
    cc: mail.cc,
    subject,
    text: mail.text,
    threadId: thread?.gmailThreadId,
    inReplyTo: answered?.messageIdHeader,
    references: answered?.references,
  });
  // What was sent is kept like any other mail of that conversation. A new mail to somebody who
  // is not in the CRM is sent, but not kept (the rule of the sync).
  const kept = await keepMessage(token, { userId: connection.userId, googleEmail: own }, sent.id, {
    force: Boolean(thread),
    sentBy: actor._id,
  });
  await writeAudit({
    actor,
    action: 'email.sent',
    entityType: 'email_threads',
    entityId: kept.threadId ?? thread?._id,
    newValue: { to, subject, files: attachments.map((file) => file.filename) },
    requestId: context.requestId,
  });
  return {
    sent: true,
    isKept: Boolean(kept.threadId),
    threadId: kept.threadId ? String(kept.threadId) : null,
  };
}

/** Ask the AI to read a conversation again (what it is, whether it needs an answer). */
export async function classifyNow(actor, threadId) {
  const thread = await loadThreadForViewer(actor, threadId);
  await classifyThread(thread._id, actor._id);
  return getThread(actor, thread._id);
}

/**
 * A draft answer for a conversation. Nothing is sent: the person reads, changes
 * and sends it themselves.
 * @param {{ instruction?: string }} options  Validated
 * @returns {Promise<{ body: string }>}
 */
export async function draftAnswer(actor, threadId, { instruction } = {}) {
  const thread = await loadThreadForViewer(actor, threadId);
  const [emails, contact, account, lead] = await Promise.all([
    Email.find({ threadId: thread._id }).sort({ sentAt: -1 }).limit(6).lean(),
    thread.contactId ? Contact.findById(thread.contactId).select('name designation').lean() : null,
    thread.accountId ? Account.findById(thread.accountId).select('name industry').lean() : null,
    thread.opportunityId
      ? Opportunity.findById(thread.opportunityId).select('name requirement stageId').lean()
      : null,
  ]);
  if (!emails.some((email) => email.direction === 'inbound')) {
    throw conflict('There is no customer message to answer in this conversation.');
  }
  const stage = lead ? await PipelineStage.findById(lead.stageId).select('name').lean() : null;
  const { output } = await draftReply({
    threadId: thread._id,
    userId: actor._id,
    sender: actor.name,
    instruction,
    customer: {
      person: contact ? [contact.name, contact.designation].filter(Boolean).join(', ') : undefined,
      company: account?.name,
      industry: account?.industry,
      lead: lead
        ? { about: lead.name, requirement: lead.requirement, stage: stage?.name }
        : undefined,
    },
    messages: emails.reverse().map((email) => ({
      direction: email.direction,
      from: email.fromName ?? email.from,
      date: email.sentAt.toISOString().slice(0, 10),
      text: (email.text || email.snippet || '').slice(0, 4000),
    })),
  });
  return { body: output.body };
}

/**
 * Let the AI write a mail, or change the one on the screen. Nothing is sent or saved: the
 * person reads it, asks for changes as often as they like, and sends it themselves.
 *
 *   mode "reply"     : an answer to the newest customer message of a conversation
 *   mode "follow_up" : the next mail in a conversation, from everything said in it so far
 *   mode "new"       : a first mail to a person of a company
 *
 * @param {{ mode: 'reply' | 'follow_up' | 'new', threadId?: string, accountId?: string,
 *           contactId?: string, instruction?: string,
 *           draft?: { subject?: string, body: string } }} request  Validated
 *        draft: the mail as it is now; with it, the instruction says what to change
 * @returns {Promise<{ subject: string, body: string }>}
 */
export async function writeWithAi(actor, request) {
  let thread = null;
  let emails = [];
  let accountId = request.accountId;
  let contactId = request.contactId;
  let leadId = null;
  if (request.threadId) {
    thread = await loadThreadForViewer(actor, request.threadId);
    emails = await Email.find({ threadId: thread._id }).sort({ sentAt: -1 }).limit(12).lean();
    accountId = thread.accountId;
    contactId = thread.contactId;
    leadId = thread.opportunityId;
    if (request.mode === 'reply' && !emails.some((email) => email.direction === 'inbound')) {
      throw conflict('There is no customer message to answer in this conversation.');
    }
  } else if (accountId) {
    await loadAccountForAction(actor, accountId, 'view');
  } else {
    throw badRequest('Say which conversation or which company the mail is for.');
  }

  const [contact, account, lead, earlier] = await Promise.all([
    contactId
      ? Contact.findOne({ _id: contactId, accountId }).select('name designation').lean()
      : null,
    accountId ? Account.findById(accountId).select('name industry').lean() : null,
    leadId ? Opportunity.findById(leadId).select('name requirement stageId').lean() : null,
    // For a new mail: what was talked about before with this company, in a line each.
    !thread && accountId
      ? EmailThread.find({ $and: [{ accountId }, await visibleThreads(actor)] })
          .select('subject lastMessageAt lastDirection snippet ai.summary')
          .sort({ lastMessageAt: -1 })
          .limit(5)
          .lean()
      : [],
  ]);
  const stage = lead ? await PipelineStage.findById(lead.stageId).select('name').lean() : null;
  const { output } = await writeEmail({
    mode: thread ? request.mode : 'new',
    threadId: thread?._id,
    accountId,
    userId: actor._id,
    sender: actor.name,
    instruction: request.instruction,
    draft: request.draft,
    subject: thread?.subject,
    customer: {
      person: contact ? [contact.name, contact.designation].filter(Boolean).join(', ') : undefined,
      company: account?.name,
      industry: account?.industry,
      lead: lead
        ? { about: lead.name, requirement: lead.requirement, stage: stage?.name }
        : undefined,
      earlierConversations: earlier.length
        ? earlier.map((item) => ({
            subject: item.subject,
            lastMailOn: item.lastMessageAt.toISOString().slice(0, 10),
            lastMailFrom: item.lastDirection === 'inbound' ? 'the customer' : 'us',
            lastMailSays: item.ai?.summary ?? item.snippet,
          }))
        : undefined,
    },
    messages: emails.reverse().map((email) => ({
      direction: email.direction,
      from: email.fromName ?? email.from,
      date: email.sentAt.toISOString().slice(0, 10),
      text: (email.text || email.snippet || '').slice(0, 3000),
      files: email.attachments?.length ? email.attachments.map((file) => file.filename) : undefined,
    })),
  });
  return { subject: output.subject, body: output.body };
}
