import { SOCKET_EVENTS } from '../constants/socketEvents.js';
import { listMessageIds } from '../integrations/google/gmail.js';
import { emitToAll } from '../infra/realtime.js';
import { writeAudit } from '../lib/audit.js';
import { can } from '../lib/can.js';
import { badRequest, conflict, forbidden } from '../lib/errors.js';
import { Contact } from '../models/contact.model.js';
import { Email, EmailThread } from '../models/email.model.js';
import { UserGoogleConnection } from '../models/userGoogleConnection.model.js';
import { loadAccountForAction } from './accounts.service.js';
import { recordActivity, relinkActivity } from './activities.service.js';
import { createContacts } from './contacts.service.js';
import { getThread, loadThreadForViewer } from './emails.service.js';
import { keepMessage } from './emailSync.service.js';
import { getGoogleAccessToken } from './googleConnection.service.js';
import { loadLeadForAction } from './opportunities.service.js';
import { quickAdd } from './quickAdd.service.js';

// Two things a person decides about customer mail, where the sync does not guess:
//   - which company, person and lead a conversation belongs to (re-link);
//   - that a sender who is not in the CRM yet is a customer: they are added, and only then is
//     their mail brought in. (The sync itself never stores mail of people outside the CRM.)

const BRING_IN_DAYS = 90;
const BRING_IN_MAX = 100;
const sameId = (a, b) => a != null && b != null && String(a) === String(b);

/**
 * Put a conversation on another company, person or lead; or on nothing (then only its owner
 * sees it). Its mails move on the timelines with it.
 * @param {{ opportunityId?: string | null, accountId?: string | null,
 *           contactId?: string | null }} links  Validated
 */
export async function relinkThread(actor, threadId, links, context = {}) {
  const thread = await loadThreadForViewer(actor, threadId);
  const mayChange =
    sameId(thread.userId, actor._id) ||
    can(actor, 'edit', { feature: 'email', record: thread, ownerField: 'userId' });
  if (!mayChange) throw forbidden('Only the owner of this conversation can change its links.');

  const next = { accountId: null, contactId: null, opportunityId: null };
  if (links.opportunityId) {
    const lead = await loadLeadForAction(actor, links.opportunityId, 'view');
    next.opportunityId = lead._id;
    next.accountId = lead.accountId;
  } else if (links.accountId) {
    next.accountId = (await loadAccountForAction(actor, links.accountId, 'view'))._id;
  }
  let person = null;
  if (links.contactId) {
    person = await Contact.findOne({ _id: links.contactId, deletedAt: null }).lean();
    if (!person || (next.accountId && !sameId(person.accountId, next.accountId))) {
      throw badRequest('Choose a person of this company', [{ field: 'contactId' }]);
    }
    if (!next.accountId) {
      next.accountId = (await loadAccountForAction(actor, person.accountId, 'view'))._id;
    }
    next.contactId = person._id;
  }

  const set = Object.fromEntries(Object.entries(next).filter(([, value]) => value));
  const unset = Object.fromEntries(
    Object.entries(next)
      .filter(([, value]) => !value)
      .map(([field]) => [field, '']),
  );
  await EmailThread.updateOne(
    { _id: thread._id },
    { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
  );

  // Every mail of the conversation moves on the timelines (or leaves them, or joins them).
  const emails = await Email.find({ threadId: thread._id }).sort({ sentAt: 1 }).limit(300).lean();
  const who = person?.name ?? thread.participants[0] ?? 'a customer';
  const hasLinks = Object.keys(set).length > 0;
  for (const email of emails) {
    const subtype = email.direction === 'inbound' ? 'email_received' : 'email_sent';
    const title =
      `Email ${email.direction === 'inbound' ? 'from' : 'to'} ${who}: ${email.subject || '(no subject)'}`.slice(
        0,
        300,
      );
    const ref = { refCollection: 'emails', refId: email._id, subtype };
    const moved = await relinkActivity(ref, { ...next, title });
    if (!moved && hasLinks) {
      await recordActivity({
        type: 'EMAIL',
        direction: email.direction,
        ...set,
        userId: thread.userId,
        occurredAt: email.sentAt,
        title,
        content: email.snippet,
        ...ref,
        metadata: { threadId: String(thread._id) },
      });
    }
  }
  await writeAudit({
    actor,
    action: 'email.relinked',
    entityType: 'email_threads',
    entityId: thread._id,
    oldValue: {
      accountId: thread.accountId ?? null,
      contactId: thread.contactId ?? null,
      opportunityId: thread.opportunityId ?? null,
    },
    newValue: next,
    requestId: context.requestId,
  });
  emitToAll(SOCKET_EVENTS.emailsChanged);
  // Unlinked, somebody other than the owner no longer sees it.
  return sameId(thread.userId, actor._id) || hasLinks ? getThread(actor, thread._id) : null;
}

/**
 * A sender who is not in the CRM yet is a customer: add them (to a new company, with a first
 * lead when wanted, or to a company that is there), then bring in the mail of the last three
 * months with them from my own mailbox.
 * @param {{ email: string, contactName: string, accountId?: string, accountName?: string,
 *           leadName?: string }} data  Validated
 * @returns {Promise<{ accountId: string, leadId: string | null, kept: number }>}
 */
export async function bringInSender(actor, data, context = {}) {
  const connection = await UserGoogleConnection.findOne({
    userId: actor._id,
    status: 'connected',
  }).lean();
  if (!connection) throw conflict('Connect your Gmail first (My profile → Mail and calendar).');
  if (await Contact.exists({ email: data.email, deletedAt: null })) {
    throw conflict('This address is in the CRM already. Its mail comes in with the next reading.');
  }
  const token = await getGoogleAccessToken(actor._id);

  const person = { name: data.contactName, email: data.email };
  let accountId;
  let leadId = null;
  if (data.accountId) {
    const account = await loadAccountForAction(actor, data.accountId, 'edit');
    await createContacts(actor, String(account._id), [person], context);
    accountId = String(account._id);
  } else {
    const made = await quickAdd(
      actor,
      {
        account: { name: data.accountName },
        contacts: [person],
        ...(data.leadName ? { lead: { name: data.leadName, source: 'email' } } : {}),
      },
      context,
    );
    accountId = made.account.id;
    leadId = made.lead?.id ?? null;
  }

  // Now that the person is in the CRM, the normal rule of the sync keeps their mail.
  const { ids } = await listMessageIds(token, {
    search: `{from:${data.email} to:${data.email} cc:${data.email}} newer_than:${BRING_IN_DAYS}d`,
    pageSize: BRING_IN_MAX,
  });
  const mailbox = { userId: actor._id, googleEmail: connection.googleEmail };
  let kept = 0;
  for (const { id } of [...ids].reverse()) {
    const result = await keepMessage(token, mailbox, id).catch(() => ({ kept: false }));
    if (result.kept) kept += 1;
  }
  if (kept > 0) emitToAll(SOCKET_EVENTS.emailsChanged);
  return { accountId, leadId, kept };
}
