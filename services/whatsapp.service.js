import { SOCKET_EVENTS } from '../constants/socketEvents.js';
import {
  isWhatsAppConfigured,
  missingWhatsAppSettings,
  sendWhatsAppTemplate,
  sendWhatsAppText,
} from '../integrations/meta/whatsapp.js';
import { logger } from '../infra/logger.js';
import { emitToAll } from '../infra/realtime.js';
import { writeAudit } from '../lib/audit.js';
import { can, getScope } from '../lib/can.js';
import { conflict, createAppError, notFound } from '../lib/errors.js';
import { containsPattern, runListQuery } from '../lib/queryBuilder.js';
import { scopeFilter } from '../lib/scopeFilter.js';
import { Account } from '../models/account.model.js';
import { Contact } from '../models/contact.model.js';
import { Opportunity } from '../models/opportunity.model.js';
import { User } from '../models/user.model.js';
import { WhatsAppConversation, WhatsAppMessage } from '../models/whatsapp.model.js';
import { recordActivity } from './activities.service.js';
import { optOutByMessage } from './bulkOptOuts.service.js';
import { notify } from './notifications.service.js';
import { registerWebhookProcessor } from './webhooks.service.js';

// WhatsApp with customers (Master Prompt Section 19; docs/WHATSAPP.md).
//
//   - One conversation per customer number. A number that belongs to a contact of the CRM is
//     linked to that person, their company and the company's one open lead, and is given to
//     the contact's owner. An unknown number is a conversation without a contact.
//   - Who sees a conversation: the person it is assigned to; beyond that the "whatsapp"
//     permission scope (a manager their team's, the CEO all). A conversation that is assigned
//     to nobody is seen by everyone whose scope is wider than their own conversations.
//   - WhatsApp's rule: a plain text may be sent only within 24 hours after the customer's last
//     message. Outside that window only an approved template may be sent. The server refuses,
//     whatever the screen does.
//   - Every message of a linked conversation is a WHATSAPP entry on the timeline.

const FEATURE = 'whatsapp';
const OWNERSHIP = { ownerField: 'assignedTo' };
export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
const STATUS_RANK = { queued: 0, sent: 1, delivered: 2, read: 3 };
const TYPES = ['text', 'image', 'video', 'document', 'audio'];
const TYPE_WORDS = {
  image: 'a picture',
  video: 'a video',
  document: 'a document',
  audio: 'a voice message',
  other: 'a message of a kind the CRM does not show yet',
};

const announce = () => emitToAll(SOCKET_EVENTS.whatsappChanged);
const isWindowOpen = (conversation, now) =>
  Boolean(conversation.lastInboundAt) && now - conversation.lastInboundAt < REPLY_WINDOW_MS;

/** Whether WhatsApp is set up, and what is missing (names of settings only). */
export function getWhatsAppSetup() {
  return {
    isConfigured: isWhatsAppConfigured(),
    missing: missingWhatsAppSettings(),
    // The address to give Meta: this path on the public address of the server.
    webhookPath: '/api/webhooks/meta/whatsapp',
  };
}

// ── What comes in from WhatsApp ─────────────────────────────────────────────────────────────

/** Who a number is: the contact with this phone, their company, and its one open lead. */
async function linksFor(waId) {
  const phone = `+${waId}`;
  const contact = await Contact.findOne({
    $or: [{ phone_number: phone }, { alt_phone_number: phone }],
    deletedAt: null,
  })
    .select('name accountId ownerId')
    .lean();
  if (!contact) return {};
  const leads = await Opportunity.find({
    deletedAt: null,
    status: 'open',
    $or: [{ primaryContactId: contact._id }, { accountId: contact.accountId }],
  })
    .select('_id')
    .limit(2)
    .lean();
  return {
    contactId: contact._id,
    accountId: contact.accountId,
    assignedTo: contact.ownerId ?? undefined,
    ...(leads.length === 1 ? { opportunityId: leads[0]._id } : {}),
  };
}

function onTimeline(conversation, message, who) {
  if (!conversation.accountId && !conversation.contactId && !conversation.opportunityId)
    return null;
  const isInbound = message.direction === 'inbound';
  return recordActivity({
    type: 'WHATSAPP',
    subtype: isInbound ? 'whatsapp_received' : 'whatsapp_sent',
    direction: message.direction,
    contactId: conversation.contactId,
    accountId: conversation.accountId,
    opportunityId: conversation.opportunityId,
    userId: message.sentBy ?? conversation.assignedTo,
    occurredAt: message.sentAt,
    title: `WhatsApp ${isInbound ? 'from' : 'to'} ${who}`,
    content: (message.text ?? '').slice(0, 300),
    refCollection: 'whatsapp_messages',
    refId: message._id,
    metadata: { conversationId: String(conversation._id) },
  });
}

/** One message of a customer. Stored once, however often Meta sends it. */
async function receiveMessage(incoming, profileName) {
  const waId = String(incoming.from ?? '').replace(/\D/g, '');
  if (!waId || !incoming.id) return;
  const sentAt = new Date(Number(incoming.timestamp ?? 0) * 1000 || Date.now());
  const type = TYPES.includes(incoming.type) ? incoming.type : 'other';
  // The text of a text message; the caption of a picture or a document; else what it was.
  const text =
    incoming.text?.body ||
    incoming[incoming.type]?.caption ||
    `[${TYPE_WORDS[type] ?? TYPE_WORDS.other}]`;

  let conversation = await WhatsAppConversation.findOne({ waId }).lean();
  if (!conversation) {
    const links = await linksFor(waId);
    conversation = await WhatsAppConversation.findOneAndUpdate(
      { waId },
      { $setOnInsert: { waId, ...links } },
      { upsert: true, returnDocument: 'after' },
    ).lean();
  }
  let message;
  try {
    message = await WhatsAppMessage.create({
      conversationId: conversation._id,
      wamid: incoming.id,
      direction: 'inbound',
      type,
      text: String(text).slice(0, 5000),
      status: 'received',
      sentAt,
    });
  } catch (error) {
    if (error?.code === 11000) return; // Meta sent it again
    throw error;
  }
  // "STOP" as the whole message: no bulk messages to this number any more.
  if (/^(stop|unsubscribe)$/i.test(String(incoming.text?.body ?? '').trim())) {
    await optOutByMessage(`+${waId}`);
  }
  await WhatsAppConversation.updateOne(
    { _id: conversation._id },
    {
      $set: {
        snippet: String(text).slice(0, 300),
        status: 'open',
        ...(profileName ? { profileName: String(profileName).slice(0, 200) } : {}),
      },
      $max: { lastMessageAt: sentAt, lastInboundAt: sentAt },
      $inc: { unreadCount: 1 },
    },
  );
  const contact = conversation.contactId
    ? await Contact.findById(conversation.contactId).select('name').lean()
    : null;
  const who = contact?.name ?? profileName ?? `+${waId}`;
  await onTimeline(conversation, message, who);
  if (conversation.assignedTo) {
    await notify({
      userId: conversation.assignedTo,
      type: 'whatsapp_received',
      title: `WhatsApp from ${who}`,
      body: String(text).slice(0, 200),
      link: `/inbox?channel=whatsapp&conversation=${conversation._id}`,
      dedupeKey: `whatsapp:${incoming.id}`,
    });
  }
}

/** How far a message of ours got. It only ever moves forward. */
async function receiveStatus(update) {
  const message = update.id ? await WhatsAppMessage.findOne({ wamid: update.id }).lean() : null;
  if (!message || message.direction !== 'outbound') return;
  if (update.status === 'failed') {
    const reason = update.errors?.[0];
    await WhatsAppMessage.updateOne(
      { _id: message._id },
      {
        $set: {
          status: 'failed',
          errorCode: reason?.code ? String(reason.code) : undefined,
          errorMessage: String(reason?.title ?? reason?.message ?? 'Not delivered').slice(0, 300),
        },
      },
    );
    return;
  }
  const next = STATUS_RANK[update.status];
  if (next === undefined || message.status === 'failed') return;
  if (next > (STATUS_RANK[message.status] ?? -1)) {
    await WhatsAppMessage.updateOne({ _id: message._id }, { $set: { status: update.status } });
  }
}

/** One webhook event of Meta: new messages of customers, and news about messages of ours. */
async function processWhatsAppEvent(event) {
  let firstError = null;
  for (const entry of event.payload?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue;
      const value = change.value ?? {};
      const names = new Map(
        (value.contacts ?? []).map((person) => [person.wa_id, person.profile?.name]),
      );
      const steps = [
        ...(value.messages ?? []).map((item) => () => receiveMessage(item, names.get(item.from))),
        ...(value.statuses ?? []).map((item) => () => receiveStatus(item)),
      ];
      for (const step of steps) {
        try {
          await step();
        } catch (error) {
          // One message that cannot be stored must not lose the others; the event is tried again.
          logger.warn({ err: error }, 'A WhatsApp event could not be stored');
          firstError ??= error;
        }
      }
    }
  }
  announce();
  if (firstError) throw firstError;
}
registerWebhookProcessor('whatsapp', processWhatsAppEvent);

// ── What the screens read and do ────────────────────────────────────────────────────────────

/** The conversations a person may see. */
function visibleTo(actor) {
  const byPermission = scopeFilter(actor, FEATURE, OWNERSHIP);
  if (Object.keys(byPermission).length === 0) return {};
  const parts = [byPermission, { assignedTo: actor._id }];
  // Wider than one's own: also the conversations nobody has taken yet.
  if (getScope(actor, FEATURE, 'view') !== 'own') parts.push({ assignedTo: null });
  return { $or: parts };
}

async function loadConversation(actor, conversationId, action = 'view') {
  const conversation = await WhatsAppConversation.findOne({
    $and: [{ _id: conversationId }, visibleTo(actor)],
  }).lean();
  if (!conversation) throw notFound('Conversation not found');
  if (action !== 'view' && !can(actor, action, { feature: FEATURE })) {
    throw createAppError('FORBIDDEN', 403, 'You do not have permission to do this.');
  }
  return conversation;
}

async function namesOf(conversations) {
  const ids = (field) => [
    ...new Set(
      conversations
        .map((item) => item[field])
        .filter(Boolean)
        .map(String),
    ),
  ];
  const byId = (items) => new Map(items.map((item) => [String(item._id), item]));
  const [contacts, accounts, leads, users] = await Promise.all([
    Contact.find({ _id: { $in: ids('contactId') } })
      .select('name')
      .lean(),
    Account.find({ _id: { $in: ids('accountId') } })
      .select('name')
      .lean(),
    Opportunity.find({ _id: { $in: ids('opportunityId') } })
      .select('name')
      .lean(),
    User.find({ _id: { $in: ids('assignedTo') } })
      .select('name')
      .lean(),
  ]);
  return {
    contacts: byId(contacts),
    accounts: byId(accounts),
    leads: byId(leads),
    users: byId(users),
  };
}

function toView(conversation, names, now) {
  const named = (map, id) => {
    const item = id && map.get(String(id));
    return item ? { id: String(item._id), name: item.name } : null;
  };
  const contact = named(names.contacts, conversation.contactId);
  return {
    id: String(conversation._id),
    phone: `+${conversation.waId}`,
    // The contact's name; else what they call themselves on WhatsApp; else the number.
    name: contact?.name ?? conversation.profileName ?? `+${conversation.waId}`,
    contact,
    account: named(names.accounts, conversation.accountId),
    lead: named(names.leads, conversation.opportunityId),
    assignedTo: named(names.users, conversation.assignedTo),
    snippet: conversation.snippet ?? '',
    lastMessageAt: conversation.lastMessageAt ?? null,
    unreadCount: conversation.unreadCount,
    // Free text may be sent until this moment; afterwards only an approved template.
    isWindowOpen: isWindowOpen(conversation, now),
    windowClosesAt: conversation.lastInboundAt
      ? new Date(conversation.lastInboundAt.getTime() + REPLY_WINDOW_MS)
      : null,
  };
}

/**
 * Conversations, newest first.
 * @param {{ view?: 'all' | 'unread' | 'mine', search?: string, accountId?: string,
 *           page: number, pageSize: number }} query  Validated
 */
export async function listConversations(actor, query, now = new Date()) {
  const pattern = query.search ? containsPattern(query.search) : null;
  const filter = {
    $and: [
      visibleTo(actor),
      query.view === 'unread' ? { unreadCount: { $gt: 0 } } : {},
      query.view === 'mine' ? { assignedTo: actor._id } : {},
      query.accountId ? { accountId: query.accountId } : {},
      pattern ? { $or: [{ waId: pattern }, { profileName: pattern }, { snippet: pattern }] } : {},
    ],
  };
  const { rows, pagination } = await runListQuery(WhatsAppConversation, {
    filter,
    sort: { lastMessageAt: -1, _id: -1 },
    page: query.page,
    pageSize: query.pageSize,
  });
  const names = await namesOf(rows);
  return { items: rows.map((row) => toView(row, names, now)), pagination };
}

/** One conversation with its messages, oldest first. Opening it marks it as read. */
export async function getConversation(actor, conversationId, now = new Date()) {
  const conversation = await loadConversation(actor, conversationId);
  const messages = await WhatsAppMessage.find({ conversationId: conversation._id })
    .sort({ sentAt: -1, _id: -1 })
    .limit(200)
    .lean();
  if (conversation.unreadCount > 0) {
    await WhatsAppConversation.updateOne({ _id: conversation._id }, { $set: { unreadCount: 0 } });
    announce();
  }
  const senders = await User.find({
    _id: { $in: messages.map((item) => item.sentBy).filter(Boolean) },
  })
    .select('name')
    .lean();
  const senderNames = new Map(senders.map((user) => [String(user._id), user.name]));
  return {
    ...toView({ ...conversation, unreadCount: 0 }, await namesOf([conversation]), now),
    messages: messages.reverse().map((message) => ({
      id: String(message._id),
      direction: message.direction,
      type: message.type,
      text: message.text ?? '',
      status: message.status,
      error: message.errorMessage ?? null,
      sentBy: message.sentBy ? (senderNames.get(String(message.sentBy)) ?? null) : null,
      sentAt: message.sentAt,
    })),
    permissions: { canSend: can(actor, 'create', { feature: FEATURE }) },
  };
}

/**
 * Answer a customer with a plain text. Only inside the 24 hours after their last message:
 * WhatsApp allows nothing else, and the server refuses it whatever the screen does.
 * @param {{ text: string }} body  Validated
 */
export async function sendText(actor, conversationId, { text }, context = {}, now = new Date()) {
  const conversation = await loadConversation(actor, conversationId, 'create');
  if (!isWindowOpen(conversation, now)) {
    throw createAppError(
      'WHATSAPP_WINDOW_CLOSED',
      409,
      'The customer last wrote more than 24 hours ago. WhatsApp then allows only an approved template message.',
    );
  }
  let sent;
  try {
    sent = await sendWhatsAppText(conversation.waId, text);
  } catch (error) {
    // Kept as a failed message, so the conversation shows what was tried.
    await WhatsAppMessage.create({
      conversationId: conversation._id,
      direction: 'outbound',
      type: 'text',
      text,
      status: 'failed',
      errorCode: error?.providerCode,
      errorMessage: String(error?.message ?? 'Not sent').slice(0, 300),
      sentBy: actor._id,
      sentAt: now,
    });
    announce();
    throw error;
  }
  const message = await WhatsAppMessage.create({
    conversationId: conversation._id,
    wamid: sent.wamid || undefined,
    direction: 'outbound',
    type: 'text',
    text,
    status: 'sent',
    sentBy: actor._id,
    sentAt: now,
  });
  await WhatsAppConversation.updateOne(
    { _id: conversation._id },
    {
      $set: {
        snippet: text.slice(0, 300),
        lastMessageAt: now,
        // The first person who answers a conversation nobody had takes it.
        ...(conversation.assignedTo ? {} : { assignedTo: actor._id }),
      },
    },
  );
  const contact = conversation.contactId
    ? await Contact.findById(conversation.contactId).select('name').lean()
    : null;
  await onTimeline(
    conversation,
    message,
    contact?.name ?? conversation.profileName ?? `+${conversation.waId}`,
  );
  await writeAudit({
    actor,
    action: 'whatsapp.sent',
    entityType: 'whatsapp_conversations',
    entityId: conversation._id,
    newValue: { to: `+${conversation.waId}`, characters: text.length },
    requestId: context.requestId,
  });
  announce();
  return getConversation(actor, conversation._id, now);
}

/**
 * Give a conversation to a person (or to nobody). The new person must be an active user.
 * @param {{ assignedTo: string | null }} body  Validated
 */
export async function assignConversation(actor, conversationId, { assignedTo }, context = {}) {
  const conversation = await loadConversation(actor, conversationId, 'edit');
  if (assignedTo && !(await User.exists({ _id: assignedTo, status: 'active' }))) {
    throw conflict('Choose an active user.');
  }
  await WhatsAppConversation.updateOne(
    { _id: conversation._id },
    assignedTo ? { $set: { assignedTo } } : { $unset: { assignedTo: '' } },
  );
  await writeAudit({
    actor,
    action: 'whatsapp.assigned',
    entityType: 'whatsapp_conversations',
    entityId: conversation._id,
    oldValue: { assignedTo: conversation.assignedTo ? String(conversation.assignedTo) : null },
    newValue: { assignedTo: assignedTo ?? null },
    requestId: context.requestId,
  });
  announce();
  return { assigned: true };
}

/**
 * Send an approved template to a number: the way to write first, or after the 24 hours. The
 * message is kept in that number's conversation (made when there is none) and on the timeline.
 * Used by bulk sending; the caller has checked that the actor may write to this person.
 * @param {{ phone: string, templateName: string, language: string, params?: string[] }} message
 *        phone: in the international form ("+919876543210")
 * @returns {Promise<{ conversationId: string }>}
 */
export async function sendTemplateMessage(actor, message, now = new Date()) {
  const waId = String(message.phone ?? '').replace(/\D/g, '');
  if (waId.length < 8)
    throw createAppError('WHATSAPP_BAD_NUMBER', 400, 'The phone number is not complete.');
  const sent = await sendWhatsAppTemplate(waId, {
    name: message.templateName,
    language: message.language,
    params: message.params,
  });
  let conversation = await WhatsAppConversation.findOne({ waId }).lean();
  if (!conversation) {
    conversation = await WhatsAppConversation.findOneAndUpdate(
      { waId },
      { $setOnInsert: { waId, ...(await linksFor(waId)) } },
      { upsert: true, returnDocument: 'after' },
    ).lean();
  }
  const text = [`[Template: ${message.templateName}]`, ...(message.params ?? [])].join(' ');
  const saved = await WhatsAppMessage.create({
    conversationId: conversation._id,
    wamid: sent.wamid || undefined,
    direction: 'outbound',
    type: 'template',
    templateName: message.templateName,
    text: text.slice(0, 5000),
    status: 'sent',
    sentBy: actor._id,
    sentAt: now,
  });
  await WhatsAppConversation.updateOne(
    { _id: conversation._id },
    { $set: { snippet: text.slice(0, 300), lastMessageAt: now } },
  );
  const contact = conversation.contactId
    ? await Contact.findById(conversation.contactId).select('name').lean()
    : null;
  await onTimeline(conversation, saved, contact?.name ?? `+${waId}`);
  announce();
  return { conversationId: String(conversation._id) };
}
