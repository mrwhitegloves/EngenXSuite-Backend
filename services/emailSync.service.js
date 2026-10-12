import { getAiSettings, isAiReady } from '../ai/settings.js';
import { classifyEmail } from '../ai/tasks/emailTasks.js';
import { SOCKET_EVENTS } from '../constants/socketEvents.js';
import {
  getMailboxProfile,
  getMessage,
  getMessageParties,
  listMessageIds,
  listNewMessageIds,
} from '../integrations/google/gmail.js';
import { logger } from '../infra/logger.js';
import { emitToAll } from '../infra/realtime.js';
import { Contact } from '../models/contact.model.js';
import { Email, EmailThread } from '../models/email.model.js';
import { Opportunity } from '../models/opportunity.model.js';
import { UserGoogleConnection } from '../models/userGoogleConnection.model.js';
import { recordActivity } from './activities.service.js';
import { getGoogleAccessToken } from './googleConnection.service.js';
import { notify } from './notifications.service.js';

// Bringing customer mail from a connected Gmail mailbox into the CRM.
//
// THE RULE: only mail with a person who is in the CRM is kept. For every message we first ask
// Gmail only who it is from and to (no text). When none of those addresses belongs to a contact
// (and the message is not part of a conversation we already keep), the message is left alone:
// its text is never fetched, nothing about it is stored.
//
// The first sync looks at the last 30 days; after that only at what is new (Gmail's history).
// Every step is safe to run twice: a message is stored once (unique index).

const NOT_DELETED = { deletedAt: null };
const FIRST_SYNC_DAYS = 30;
const FIRST_SYNC_MAX = 300;
const CATCH_UP_DAYS = 7;
const TEXT_MAX = 50_000;
// Another run on the same mailbox counts as dead after this long.
const SYNC_STALE_MS = 10 * 60 * 1000;
// Not customer mail, whatever the addresses say.
const SKIP_LABELS = ['DRAFT', 'SPAM', 'TRASH', 'CHAT'];

const unique = (values) => [...new Set(values.filter(Boolean))];

/** The contacts of the CRM behind some email addresses. */
const contactsOf = (addresses) =>
  addresses.length === 0
    ? []
    : Contact.find({ email: { $in: addresses }, ...NOT_DELETED })
        .select('name email accountId')
        .lean();

/**
 * Who a conversation is with. One company → that company, its person, and its open lead when
 * there is exactly one. People of several companies → nothing: left for a person to decide.
 */
async function linksFor(contacts, fromAddress) {
  const accountIds = unique(contacts.map((contact) => String(contact.accountId)));
  if (accountIds.length !== 1) return {};
  const contact = contacts.find((item) => item.email === fromAddress) ?? contacts[0];
  const leads = await Opportunity.find({
    ...NOT_DELETED,
    status: 'open',
    $or: [
      { primaryContactId: { $in: contacts.map((item) => item._id) } },
      { accountId: contact.accountId },
    ],
  })
    .select('_id')
    .limit(2)
    .lean();
  return {
    contactId: contact._id,
    accountId: contact.accountId,
    ...(leads.length === 1 ? { opportunityId: leads[0]._id } : {}),
  };
}

/** Bring a conversation's summary line in step with its stored messages. */
async function refreshThread(threadId) {
  const [count, newest, oldest] = await Promise.all([
    Email.countDocuments({ threadId }),
    Email.findOne({ threadId }).sort({ sentAt: -1 }).lean(),
    Email.findOne({ threadId }).sort({ sentAt: 1 }).select('subject').lean(),
  ]);
  if (!newest) return;
  await EmailThread.updateOne(
    { _id: threadId },
    {
      $set: {
        messageCount: count,
        lastMessageAt: newest.sentAt,
        lastDirection: newest.direction,
        snippet: newest.snippet,
        subject: oldest.subject || newest.subject || '(no subject)',
      },
    },
  );
}

/**
 * The AI's reading of a conversation, after a new customer message. A problem here (no budget,
 * the AI is down) is logged and never stops the sync.
 * @param {unknown} threadId
 * @param {unknown} [userId]  Who asked; empty when the sync did it by itself
 */
export async function classifyThread(threadId, userId) {
  const emails = await Email.find({ threadId }).sort({ sentAt: -1 }).limit(6).lean();
  const newestInbound = emails.find((email) => email.direction === 'inbound');
  if (!newestInbound) return null;
  const { output, runId } = await classifyEmail({
    threadId,
    userId,
    messages: emails.reverse().map((email) => ({
      direction: email.direction,
      from: email.fromName ?? email.from,
      date: email.sentAt.toISOString().slice(0, 10),
      text: (email.text || email.snippet || '').slice(0, 4000),
    })),
  });
  const ai = { ...output, aiRunId: runId, forMessageId: newestInbound._id, at: new Date() };
  await EmailThread.updateOne({ _id: threadId }, { $set: { ai } });
  return ai;
}

/**
 * Look at one message of a mailbox and keep it when it is customer mail.
 * @param {{ userId: unknown, googleEmail: string }} mailbox
 * @param {{ announce?: boolean, force?: boolean }} [options]
 *        announce: tell the owner about a new customer mail (not during the first sync)
 *        force: keep it whoever it is with (a mail the person just sent from the CRM)
 * @returns {Promise<{ kept: boolean, threadId?: unknown, emailId?: unknown }>}
 */
export async function keepMessage(token, mailbox, messageId, options = {}) {
  const { userId, googleEmail } = mailbox;
  const known = await Email.findOne({ userId, gmailMessageId: messageId })
    .select('threadId')
    .lean();
  if (known) return { kept: false, threadId: known.threadId, emailId: known._id };

  // Step 1: only who it is from and to.
  const parties = await getMessageParties(token, messageId);
  if (parties.labels.some((label) => SKIP_LABELS.includes(label))) return { kept: false };
  const others = unique([parties.from, ...parties.to, ...parties.cc]).filter(
    (address) => address !== googleEmail,
  );
  const [contacts, thread] = await Promise.all([
    contactsOf(others),
    EmailThread.findOne({ userId, gmailThreadId: parties.threadId }).lean(),
  ]);
  // Nobody of the CRM, and not a conversation we keep: not ours to store.
  if (contacts.length === 0 && !thread && !options.force) return { kept: false };

  // Step 2: the message itself.
  const message = await getMessage(token, messageId);
  const direction = message.from === googleEmail ? 'outbound' : 'inbound';
  const links = thread
    ? {
        contactId: thread.contactId,
        accountId: thread.accountId,
        opportunityId: thread.opportunityId,
      }
    : await linksFor(contacts, message.from);
  const saved =
    thread ??
    (await EmailThread.findOneAndUpdate(
      { userId, gmailThreadId: message.threadId },
      {
        $setOnInsert: {
          subject: message.subject || '(no subject)',
          lastMessageAt: message.sentAt,
          ...Object.fromEntries(Object.entries(links).filter(([, value]) => value)),
        },
      },
      { upsert: true, returnDocument: 'after' },
    ).lean());

  let email;
  try {
    email = await Email.create({
      threadId: saved._id,
      userId,
      gmailMessageId: message.id,
      direction,
      from: message.from,
      fromName: message.fromName ?? undefined,
      to: message.to,
      cc: message.cc,
      subject: message.subject,
      sentAt: message.sentAt,
      snippet: message.snippet,
      text: message.text.slice(0, TEXT_MAX),
      attachments: message.attachments,
      messageIdHeader: message.messageIdHeader || undefined,
      references: message.references || undefined,
    });
  } catch (error) {
    // Another run stored it a moment ago.
    if (error?.code === 11000) return { kept: false, threadId: saved._id };
    throw error;
  }
  await EmailThread.updateOne(
    { _id: saved._id },
    { $addToSet: { participants: { $each: others } } },
  );
  await refreshThread(saved._id);

  // On the timeline of the company, the person and the lead.
  const person = contacts.find((contact) => String(contact._id) === String(saved.contactId));
  const who = person?.name ?? message.fromName ?? others[0] ?? 'a customer';
  if (saved.accountId || saved.contactId || saved.opportunityId) {
    await recordActivity({
      type: 'EMAIL',
      subtype: direction === 'inbound' ? 'email_received' : 'email_sent',
      direction,
      contactId: saved.contactId,
      accountId: saved.accountId,
      opportunityId: saved.opportunityId,
      userId,
      occurredAt: message.sentAt,
      title:
        `Email ${direction === 'inbound' ? 'from' : 'to'} ${who}: ${message.subject || '(no subject)'}`.slice(
          0,
          300,
        ),
      content: message.snippet,
      refCollection: 'emails',
      refId: email._id,
      metadata: { threadId: String(saved._id) },
    });
  }

  if (direction === 'inbound' && options.announce) {
    await notify({
      userId,
      type: 'email_received',
      title: `New mail from ${who}`,
      body: message.subject || '(no subject)',
      link: `/inbox?thread=${saved._id}`,
      dedupeKey: `email:${email._id}`,
    });
    // The AI's reading, when "keep AI answers up to date" is on.
    if (isAiReady() && (await getAiSettings()).autoRefresh) {
      await classifyThread(saved._id).catch((error) =>
        logger.info({ reason: error?.message }, 'A new mail was not read by the AI'),
      );
    }
  }
  return { kept: true, threadId: saved._id, emailId: email._id };
}

/** Message ids of the last days, oldest first, up to a number. */
async function recentIds(token, days, max) {
  const ids = [];
  let pageToken;
  do {
    const page = await listMessageIds(token, { search: `newer_than:${days}d`, pageToken });
    ids.push(...page.ids);
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < max);
  return ids.slice(0, max).reverse();
}

/**
 * The background job: bring one person's mailbox up to date.
 * @returns {Promise<{ skipped?: string, looked?: number, kept?: number }>}
 */
export async function syncMailbox(userId) {
  // One run at a time per mailbox.
  const connection = await UserGoogleConnection.findOneAndUpdate(
    {
      userId,
      status: 'connected',
      $or: [
        { 'gmail.syncStartedAt': null },
        { 'gmail.syncStartedAt': { $lt: new Date(Date.now() - SYNC_STALE_MS) } },
      ],
    },
    { $set: { 'gmail.syncStartedAt': new Date() } },
  ).lean();
  if (!connection) return { skipped: 'not connected, or a sync is running' };

  const mailbox = { userId: connection.userId, googleEmail: connection.googleEmail };
  let looked = 0;
  let kept = 0;
  try {
    const token = await getGoogleAccessToken(userId);
    const isFirst = !connection.gmail?.historyId;
    let ids;
    let historyId;
    if (isFirst) {
      // The history point is taken BEFORE the listing, so nothing that arrives meanwhile is lost.
      ({ historyId } = await getMailboxProfile(token));
      ids = await recentIds(token, FIRST_SYNC_DAYS, FIRST_SYNC_MAX);
    } else {
      try {
        ({ ids, historyId } = await listNewMessageIds(token, connection.gmail.historyId));
      } catch (error) {
        if (error?.code !== 'GMAIL_NOT_FOUND') throw error;
        // Gmail forgot that point of the history (too long ago): look at the last week again.
        ({ historyId } = await getMailboxProfile(token));
        ids = await recentIds(token, CATCH_UP_DAYS, FIRST_SYNC_MAX);
      }
    }
    for (const { id } of ids) {
      looked += 1;
      try {
        const result = await keepMessage(token, mailbox, id, { announce: !isFirst });
        if (result.kept) kept += 1;
      } catch (error) {
        // A message that was deleted meanwhile, or one Gmail will not give: go on with the rest.
        if (error?.code !== 'GMAIL_NOT_FOUND') {
          logger.warn({ err: error, userId: String(userId) }, 'A mail could not be synced');
        }
      }
    }
    await UserGoogleConnection.updateOne(
      { _id: connection._id },
      {
        $set: { 'gmail.historyId': historyId, 'gmail.lastSyncAt': new Date() },
        $unset: { 'gmail.syncStartedAt': '', lastError: '' },
      },
    );
  } catch (error) {
    await UserGoogleConnection.updateOne(
      { _id: connection._id },
      {
        $set: {
          lastError: String(error?.message ?? 'The mailbox could not be read').slice(0, 300),
        },
        $unset: { 'gmail.syncStartedAt': '' },
      },
    );
    if (!error?.isAppError) throw error;
    return { skipped: error.message };
  }
  if (kept > 0) {
    emitToAll(SOCKET_EVENTS.emailsChanged);
  }
  return { looked, kept };
}

/** The ids of every person with a working connection (for the job that syncs them all). */
export async function connectedUserIds() {
  const connections = await UserGoogleConnection.find({ status: 'connected' })
    .select('userId')
    .lean();
  return connections.map((connection) => String(connection.userId));
}
