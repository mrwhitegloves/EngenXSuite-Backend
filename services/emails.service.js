import { draftReply } from '../ai/tasks/emailTasks.js';
import { JOB_NAMES } from '../constants/jobNames.js';
import { sendMessage } from '../integrations/google/gmail.js';
import { logger } from '../infra/logger.js';
import { enqueue } from '../infra/queues.js';
import { writeAudit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { runListQuery } from '../lib/queryBuilder.js';
import { scopeFilter } from '../lib/scopeFilter.js';
import { Account } from '../models/account.model.js';
import { Contact } from '../models/contact.model.js';
import { Email, EmailThread } from '../models/email.model.js';
import { Opportunity } from '../models/opportunity.model.js';
import { PipelineStage } from '../models/pipelineStage.model.js';
import { User } from '../models/user.model.js';
import { UserGoogleConnection } from '../models/userGoogleConnection.model.js';
import { classifyThread, keepMessage, syncMailbox } from './emailSync.service.js';
import { getGoogleAccessToken } from './googleConnection.service.js';

// Customer mail in the CRM: reading conversations, answering from one's own mailbox, and the
// AI's help. Bringing mail in is services/emailSync.service.js.
//
// WHO SEES WHAT (phase 06, section 8):
//   - a conversation in my own mailbox: me, always;
//   - a conversation that is linked to a company: also my manager and the CEO, by the "email"
//     permission (own / team / all);
//   - a conversation that is linked to nothing: only its owner.
// Answering is always from one's OWN mailbox: only the owner of a conversation can reply in it.

const FEATURE = 'email';
const OWNERSHIP = { ownerField: 'userId' };
const sameId = (a, b) => a != null && b != null && String(a) === String(b);

/** The conversations a person may see. */
const visibleTo = (actor) => ({
  $or: [
    { userId: actor._id },
    { $and: [scopeFilter(actor, FEATURE, OWNERSHIP), { accountId: { $ne: null } }] },
  ],
});

async function loadThread(actor, threadId) {
  const thread = await EmailThread.findOne({ $and: [{ _id: threadId }, visibleTo(actor)] }).lean();
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
  const isMine = sameId(thread.userId, actor._id);
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
          at: thread.ai.at,
        }
      : null,
    permissions: { canReply: isMine },
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
      visibleTo(actor),
      query.view === 'waiting' ? { lastDirection: 'inbound' } : {},
      query.view === 'mine' ? { userId: actor._id } : {},
      query.accountId ? { accountId: query.accountId } : {},
      query.opportunityId ? { opportunityId: query.opportunityId } : {},
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
  const thread = await loadThread(actor, threadId);
  const [names, emails] = await Promise.all([
    namesOf([thread]),
    Email.find({ threadId: thread._id }).sort({ sentAt: 1 }).lean(),
  ]);
  return {
    ...toThreadView(thread, names, actor),
    messages: emails.map((email) => ({
      id: String(email._id),
      direction: email.direction,
      from: email.from,
      fromName: email.fromName ?? null,
      to: email.to,
      cc: email.cc,
      sentAt: email.sentAt,
      text: email.text ?? '',
      attachments: email.attachments,
    })),
  };
}

/** What the Inbox needs to know about me: is my mailbox connected, when was it last read. */
export async function getMailboxStatus(actor) {
  const connection = await UserGoogleConnection.findOne({ userId: actor._id }).lean();
  return {
    isConnected: connection?.status === 'connected',
    needsReconnect: connection?.status === 'needs_reconnect',
    googleEmail: connection?.googleEmail ?? null,
    lastSyncAt: connection?.gmail?.lastSyncAt ?? null,
    lastError: connection?.lastError ?? null,
  };
}

/**
 * Bring my mailbox up to date now. With a queue it runs in the background; without one, here.
 * @returns {Promise<{ started: true }>}
 */
export async function requestSync(actor) {
  const status = await getMailboxStatus(actor);
  if (!status.isConnected)
    throw conflict('Connect your Gmail first (My profile → Mail and calendar).');
  try {
    await enqueue(
      'messaging',
      JOB_NAMES.emailSync,
      { userId: String(actor._id) },
      { jobId: `email-sync-${actor._id}-${Math.floor(Date.now() / 30_000)}` },
    );
  } catch {
    setImmediate(() =>
      syncMailbox(actor._id).catch((error) => logger.error({ err: error }, 'Mail sync failed')),
    );
  }
  return { started: true };
}

/**
 * Send a mail from my own mailbox: an answer inside a conversation, or a new mail.
 * @param {{ threadId?: string, to?: string[], cc?: string[], subject?: string, text: string }} mail
 *        Validated. With threadId the recipients and the subject come from the conversation
 *        unless given.
 */
export async function sendEmail(actor, mail, context = {}) {
  const connection = await UserGoogleConnection.findOne({
    userId: actor._id,
    status: 'connected',
  }).lean();
  if (!connection) throw conflict('Connect your Gmail first (My profile → Mail and calendar).');
  const own = connection.googleEmail;

  let thread = null;
  let answered = null;
  if (mail.threadId) {
    thread = await loadThread(actor, mail.threadId);
    if (!sameId(thread.userId, actor._id)) {
      throw forbidden('You can answer only in conversations of your own mailbox.');
    }
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

  const token = await getGoogleAccessToken(actor._id);
  const sent = await sendMessage(token, {
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
  const kept = await keepMessage(token, { userId: actor._id, googleEmail: own }, sent.id, {
    force: Boolean(thread),
  });
  await writeAudit({
    actor,
    action: 'email.sent',
    entityType: 'email_threads',
    entityId: kept.threadId ?? thread?._id,
    newValue: { to, subject },
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
  const thread = await loadThread(actor, threadId);
  await classifyThread(thread._id, actor._id);
  return getThread(actor, thread._id);
}

/**
 * A draft answer for a conversation of my mailbox. Nothing is sent: the person reads, changes
 * and sends it themselves.
 * @param {{ instruction?: string }} options  Validated
 * @returns {Promise<{ body: string }>}
 */
export async function draftAnswer(actor, threadId, { instruction } = {}) {
  const thread = await loadThread(actor, threadId);
  if (!sameId(thread.userId, actor._id)) {
    throw forbidden('You can answer only in conversations of your own mailbox.');
  }
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
