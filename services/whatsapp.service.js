import { SOCKET_EVENTS } from '../constants/socketEvents.js';
import {
  fetchWhatsAppNumber,
  fetchWhatsAppTemplates,
  isWhatsAppConfigured,
  missingWhatsAppSettings,
  sendWhatsAppMedia,
  sendWhatsAppTemplate,
  sendWhatsAppText,
  uploadWhatsAppMedia,
} from '../integrations/meta/whatsapp.js';
import { env } from '../config/env.js';
import { getOrSet, invalidate } from '../infra/cache.js';
import { logger } from '../infra/logger.js';
import { emitToAll } from '../infra/realtime.js';
import { isStorageConfigured, keyFromUrl, readObject, toReadableUrl } from '../infra/storage.js';
import { writeAudit } from '../lib/audit.js';
import { can, getScope } from '../lib/can.js';
import { badRequest, conflict, createAppError, notFound } from '../lib/errors.js';
import { containsPattern, runListQuery } from '../lib/queryBuilder.js';
import { MATCH_NOTHING, scopeFilter } from '../lib/scopeFilter.js';
import { Account } from '../models/account.model.js';
import { Contact } from '../models/contact.model.js';
import { Document } from '../models/document.model.js';
import { Opportunity } from '../models/opportunity.model.js';
import { PipelineStage } from '../models/pipelineStage.model.js';
import { User } from '../models/user.model.js';
import { WhatsAppConversation, WhatsAppMessage } from '../models/whatsapp.model.js';
import { loadAccountForAction } from './accounts.service.js';
import { recordActivity } from './activities.service.js';
import { findOptedOut, isOptedOut, optOutByMessage } from './bulkOptOuts.service.js';
import { notify } from './notifications.service.js';
import { registerWebhookProcessor } from './webhooks.service.js';
import {
  classifyFile,
  cleanFileName,
  queueIncomingMedia,
  storeWhatsAppFile,
} from './whatsappMedia.service.js';

// WhatsApp with customers (Master Prompt Section 19; docs/WHATSAPP.md).
//
//   - One conversation per customer number. A number that belongs to a contact of the CRM is
//     linked to that person, their company and the company's one open lead, and is given to
//     the contact's owner. An unknown number is a conversation without a contact until a
//     person links it.
//   - Who sees a conversation (founder, 2026-10-23, like mail in decision 0014): whoever may
//     see its company or its lead, and the person it is assigned to. A conversation of an
//     unknown number: everyone whose WhatsApp scope is wider than their own (managers, CEO).
//   - WhatsApp's rule: text and files only within 24 hours after the customer's last message.
//     Outside that window only an approved template. The server refuses, whatever the screen
//     does. A number on the "do not write to" list (STOP) gets nothing at all.
//   - Every message of a linked conversation is a WHATSAPP entry on the timeline.

const FEATURE = 'whatsapp';
const NOT_DELETED = { deletedAt: null };
export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const THREAD_PAGE_SIZE = 40;
const TEMPLATES_CACHE_KEY = 'whatsapp:templates';
const TEMPLATES_CACHE_SECONDS = 600;
const STATUS_RANK = { queued: 0, sent: 1, delivered: 2, read: 3 };
const MEDIA_TYPES = ['image', 'video', 'document', 'audio', 'sticker'];
const TYPES = [...MEDIA_TYPES, 'text', 'location', 'reaction'];
const TYPE_WORDS = {
  image: 'Photo',
  video: 'Video',
  document: 'Document',
  audio: 'Voice message',
  sticker: 'Sticker',
  location: 'Location',
  other: 'A message of a kind the CRM does not show yet',
};

const announce = () => emitToAll(SOCKET_EVENTS.whatsappChanged);
const ids = (items) => items.map((item) => item._id);
const isWindowOpen = (conversation, now) =>
  Boolean(conversation.lastInboundAt) && now - conversation.lastInboundAt < REPLY_WINDOW_MS;
const needsReply = (conversation) =>
  Boolean(conversation.lastInboundAt) &&
  (!conversation.lastOutboundAt || conversation.lastInboundAt > conversation.lastOutboundAt);
const phoneOf = (conversation) => `+${conversation.waId}`;

/** Whether WhatsApp is set up, and what is missing (names of settings only). */
export function getWhatsAppSetup() {
  return {
    isConfigured: isWhatsAppConfigured(),
    missing: missingWhatsAppSettings(),
    hasBusinessAccount: Boolean(env.WHATSAPP_BUSINESS_ACCOUNT_ID),
    // The address to give Meta: this path on the public address of the server.
    webhookPath: '/api/webhooks/meta/whatsapp',
  };
}

/** Settings → WhatsApp: the setup, and the business number as Meta shows it. */
export async function getWhatsAppStatus() {
  const setup = getWhatsAppSetup();
  if (!setup.isConfigured) return { ...setup, number: null, numberError: null };
  try {
    return { ...setup, number: await fetchWhatsAppNumber(), numberError: null };
  } catch (error) {
    return { ...setup, number: null, numberError: error.message };
  }
}

// ── Who a number is ─────────────────────────────────────────────────────────────────────────

/** The links of a conversation of this contact: the person, their company, its one open lead. */
async function linksForContact(contact) {
  const leads = await Opportunity.find({
    ...NOT_DELETED,
    status: 'open',
    $or: [{ primaryContactId: contact._id }, { accountId: contact.accountId }],
  })
    .select('_id primaryContactId')
    .limit(10)
    .lean();
  // The lead of this person first; otherwise the company's lead when it has exactly one.
  const own = leads.filter((lead) => String(lead.primaryContactId) === String(contact._id));
  const lead = own.length === 1 ? own[0] : leads.length === 1 ? leads[0] : null;
  return {
    contactId: contact._id,
    accountId: contact.accountId,
    ...(contact.ownerId ? { assignedTo: contact.ownerId } : {}),
    ...(lead ? { opportunityId: lead._id } : {}),
  };
}

/** Who a number is: the contact with this phone (first one found), with their links. */
async function linksFor(waId) {
  const phone = `+${waId}`;
  const contact = await Contact.findOne({
    $or: [{ phone_number: phone }, { alt_phone_number: phone }],
    ...NOT_DELETED,
  })
    .select('name accountId ownerId')
    .lean();
  return contact ? linksForContact(contact) : {};
}

async function conversationForNumber(waId) {
  const found = await WhatsAppConversation.findOne({ waId }).lean();
  if (found) return found;
  const links = await linksFor(waId);
  return WhatsAppConversation.findOneAndUpdate(
    { waId },
    { $setOnInsert: { waId, ...links } },
    { upsert: true, returnDocument: 'after' },
  ).lean();
}

async function displayNameOf(conversation) {
  const contact = conversation.contactId
    ? await Contact.findById(conversation.contactId).select('name').lean()
    : null;
  return contact?.name ?? conversation.profileName ?? phoneOf(conversation);
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

/** The one-line preview of a message in the list. */
function snippetOf(message) {
  if (message.type === 'reaction') return `Reacted ${message.reaction?.emoji ?? ''}`.trim();
  if (message.type === 'template') return message.text ?? `Template: ${message.templateName}`;
  const word = TYPE_WORDS[message.type];
  if (MEDIA_TYPES.includes(message.type) || message.type === 'location') {
    return message.text ? `${word}: ${message.text}` : word;
  }
  return message.text ?? '';
}

// ── What comes in from WhatsApp ─────────────────────────────────────────────────────────────

/** The parts of a customer's message that we keep, by its kind. */
function readIncoming(incoming) {
  const type = TYPES.includes(incoming.type) ? incoming.type : 'other';
  const part = incoming[incoming.type] ?? {};
  const kept = { type };
  if (type === 'text') kept.text = part.body ?? '';
  if (MEDIA_TYPES.includes(type)) {
    kept.text = part.caption ?? '';
    kept.media = {
      providerMediaId: part.id,
      mimeType: part.mime_type,
      fileName: part.filename ? cleanFileName(part.filename) : undefined,
      status: 'pending',
    };
  }
  if (type === 'location') {
    kept.location = {
      latitude: part.latitude,
      longitude: part.longitude,
      name: part.name,
      address: part.address,
    };
    kept.text = [part.name, part.address].filter(Boolean).join(', ');
  }
  if (type === 'reaction') {
    kept.reaction = { emoji: part.emoji ?? '', wamid: part.message_id };
    kept.text = part.emoji ?? '';
  }
  if (type === 'other') kept.text = `[${TYPE_WORDS.other}]`;
  return kept;
}

/** One message of a customer. Stored once, however often Meta sends it. */
async function receiveMessage(incoming, profileName) {
  const waId = String(incoming.from ?? '').replace(/\D/g, '');
  if (!waId || !incoming.id) return;
  const sentAt = new Date(Number(incoming.timestamp ?? 0) * 1000 || Date.now());
  const kept = readIncoming(incoming);
  const conversation = await conversationForNumber(waId);
  const replyTo = incoming.context?.id
    ? await WhatsAppMessage.findOne({ wamid: incoming.context.id }).select('_id').lean()
    : null;
  let message;
  try {
    message = await WhatsAppMessage.create({
      conversationId: conversation._id,
      wamid: incoming.id,
      direction: 'inbound',
      ...kept,
      text: String(kept.text ?? '').slice(0, 5000),
      ...(replyTo ? { replyToId: replyTo._id } : {}),
      status: 'received',
      sentAt,
    });
  } catch (error) {
    if (error?.code === 11000) return; // Meta sent it again
    throw error;
  }
  // "STOP" as the whole message: nothing more to this number.
  if (/^(stop|unsubscribe)$/i.test(String(incoming.text?.body ?? '').trim())) {
    await optOutByMessage(`+${waId}`);
  }
  const isReaction = kept.type === 'reaction';
  await WhatsAppConversation.updateOne(
    { _id: conversation._id },
    {
      $set: {
        snippet: snippetOf(message).slice(0, 300),
        lastDirection: 'inbound',
        status: 'open',
        ...(profileName ? { profileName: String(profileName).slice(0, 200) } : {}),
      },
      $max: { lastMessageAt: sentAt, lastInboundAt: sentAt },
      // A reaction is not a message to read.
      ...(isReaction ? {} : { $inc: { unreadCount: 1 } }),
    },
  );
  if (kept.media) await queueIncomingMedia(message._id);
  if (isReaction) return;
  const who = await displayNameOf({ ...conversation, profileName });
  await onTimeline(conversation, message, who);
  if (conversation.assignedTo) {
    await notify({
      userId: conversation.assignedTo,
      type: 'whatsapp_received',
      title: `WhatsApp from ${who}`,
      body: snippetOf(message).slice(0, 200),
      link: `/whatsapp/${conversation._id}`,
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
          errorMessage: String(
            reason?.error_data?.details ?? reason?.title ?? reason?.message ?? 'Not delivered',
          ).slice(0, 300),
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

// ── Who may see what ────────────────────────────────────────────────────────────────────────

/** The conversations a person may see (a MongoDB filter). */
export async function visibleConversations(actor) {
  const scope = getScope(actor, FEATURE, 'view');
  if (scope === null) return MATCH_NOTHING;
  if (getScope(actor, 'accounts', 'view') === 'all') return {};
  const [accounts, leads] = await Promise.all([
    Account.find({ $and: [scopeFilter(actor, 'accounts'), NOT_DELETED] })
      .select('_id')
      .lean(),
    Opportunity.find({ $and: [scopeFilter(actor, 'opportunities'), NOT_DELETED] })
      .select('_id')
      .lean(),
  ]);
  const parts = [
    { accountId: { $in: ids(accounts) } },
    { opportunityId: { $in: ids(leads) } },
    { assignedTo: actor._id },
  ];
  // Wider than one's own: also the numbers that are not in the CRM yet.
  if (scope !== 'own') parts.push({ contactId: null, accountId: null });
  return { $or: parts };
}

export async function loadConversation(actor, conversationId, action = 'view') {
  const conversation = await WhatsAppConversation.findOne({
    $and: [{ _id: conversationId }, await visibleConversations(actor)],
  }).lean();
  if (!conversation) throw notFound('Conversation not found');
  if (action !== 'view' && !can(actor, action, { feature: FEATURE })) {
    throw createAppError('FORBIDDEN', 403, 'You do not have permission to do this.');
  }
  return conversation;
}

// ── What the screens read ───────────────────────────────────────────────────────────────────

async function namesOf(conversations) {
  const idsOf = (field) => [
    ...new Set(
      conversations
        .map((item) => item[field])
        .filter(Boolean)
        .map(String),
    ),
  ];
  const byId = (items) => new Map(items.map((item) => [String(item._id), item]));
  const [contacts, accounts, leads, users, optedOut] = await Promise.all([
    Contact.find({ _id: { $in: idsOf('contactId') } })
      .select('name designation email consent')
      .lean(),
    Account.find({ _id: { $in: idsOf('accountId') } })
      .select('name accountCode')
      .lean(),
    Opportunity.find({ _id: { $in: idsOf('opportunityId') } })
      .select('name leadCode stageId status')
      .lean(),
    User.find({ _id: { $in: idsOf('assignedTo') } })
      .select('name')
      .lean(),
    findOptedOut('whatsapp', conversations.map(phoneOf)),
  ]);
  const stages = await PipelineStage.find({
    _id: { $in: [...new Set(leads.map((lead) => String(lead.stageId)))] },
  })
    .select('name')
    .lean();
  return {
    contacts: byId(contacts),
    accounts: byId(accounts),
    leads: byId(leads),
    users: byId(users),
    stages: byId(stages),
    optedOut,
  };
}

function toView(conversation, names, now) {
  const get = (map, id) => (id ? map.get(String(id)) : null);
  const contact = get(names.contacts, conversation.contactId);
  const account = get(names.accounts, conversation.accountId);
  const lead = get(names.leads, conversation.opportunityId);
  const user = get(names.users, conversation.assignedTo);
  const stage = lead ? get(names.stages, lead.stageId) : null;
  return {
    id: String(conversation._id),
    phone: phoneOf(conversation),
    // The contact's name; else what they call themselves on WhatsApp; else the number.
    name: contact?.name ?? conversation.profileName ?? phoneOf(conversation),
    profileName: conversation.profileName ?? null,
    contact: contact
      ? {
          id: String(contact._id),
          name: contact.name,
          designation: contact.designation ?? null,
          email: contact.email ?? null,
          whatsappOptIn: contact.consent?.whatsappOptIn ?? false,
        }
      : null,
    account: account
      ? { id: String(account._id), name: account.name, code: account.accountCode }
      : null,
    lead: lead
      ? {
          id: String(lead._id),
          name: lead.name,
          code: lead.leadCode,
          status: lead.status,
          stage: stage ? { id: String(stage._id), name: stage.name } : null,
        }
      : null,
    assignedTo: user ? { id: String(user._id), name: user.name } : null,
    snippet: conversation.snippet ?? '',
    lastDirection: conversation.lastDirection ?? null,
    lastMessageAt: conversation.lastMessageAt ?? null,
    unreadCount: conversation.unreadCount,
    needsReply: needsReply(conversation),
    optedOut: names.optedOut.has(phoneOf(conversation)),
    // Free text and files may be sent until this moment; afterwards only an approved template.
    isWindowOpen: isWindowOpen(conversation, now),
    windowClosesAt: conversation.lastInboundAt
      ? new Date(conversation.lastInboundAt.getTime() + REPLY_WINDOW_MS)
      : null,
  };
}

/** The filter parts of the list, without the tab. */
async function listFilterParts(actor, query) {
  const parts = [await visibleConversations(actor)];
  if (query.accountId) parts.push({ accountId: query.accountId });
  if (query.contactId) parts.push({ contactId: query.contactId });
  if (query.assignedTo === 'unassigned') parts.push({ assignedTo: null });
  else if (query.assignedTo) parts.push({ assignedTo: query.assignedTo });
  if (query.stageId) {
    const leads = await Opportunity.find({ stageId: query.stageId, ...NOT_DELETED })
      .select('_id')
      .lean();
    parts.push({ opportunityId: { $in: ids(leads) } });
  }
  if (query.tagId) {
    const [accounts, contacts, leads] = await Promise.all([
      Account.find({ tagIds: query.tagId, ...NOT_DELETED })
        .select('_id')
        .lean(),
      Contact.find({ tagIds: query.tagId, ...NOT_DELETED })
        .select('_id')
        .lean(),
      Opportunity.find({ tagIds: query.tagId, ...NOT_DELETED })
        .select('_id')
        .lean(),
    ]);
    parts.push({
      $or: [
        { accountId: { $in: ids(accounts) } },
        { contactId: { $in: ids(contacts) } },
        { opportunityId: { $in: ids(leads) } },
      ],
    });
  }
  if (query.search) {
    const pattern = containsPattern(query.search);
    const digits = query.search.replace(/\D/g, '');
    const [contacts, accounts, leads] = await Promise.all([
      Contact.find({ name: pattern, ...NOT_DELETED })
        .select('_id')
        .limit(200)
        .lean(),
      Account.find({ $or: [{ name: pattern }, { accountCode: pattern }], ...NOT_DELETED })
        .select('_id')
        .limit(200)
        .lean(),
      Opportunity.find({ $or: [{ name: pattern }, { leadCode: pattern }], ...NOT_DELETED })
        .select('_id')
        .limit(200)
        .lean(),
    ]);
    parts.push({
      $or: [
        ...(digits.length >= 3 ? [{ waId: containsPattern(digits) }] : []),
        { profileName: pattern },
        { contactId: { $in: ids(contacts) } },
        { accountId: { $in: ids(accounts) } },
        { opportunityId: { $in: ids(leads) } },
      ],
    });
  }
  return parts;
}

/** The tabs of the list, each as a filter. */
function tabFilters(actor, now) {
  return {
    all: {},
    unread: { unreadCount: { $gt: 0 } },
    needs_reply: {
      lastInboundAt: { $ne: null },
      $expr: { $gt: ['$lastInboundAt', { $ifNull: ['$lastOutboundAt', new Date(0)] }] },
    },
    window_open: { lastInboundAt: { $gte: new Date(now.getTime() - REPLY_WINDOW_MS) } },
    unknown: { contactId: null },
    mine: { assignedTo: actor._id },
  };
}

/**
 * Conversations, newest first, with the number of conversations in each tab.
 * @param {{ view?: string, search?: string, accountId?: string, contactId?: string,
 *           assignedTo?: string, stageId?: string, tagId?: string,
 *           page: number, pageSize: number }} query  Validated
 */
export async function listConversations(actor, query, now = new Date()) {
  const parts = await listFilterParts(actor, query);
  const tabs = tabFilters(actor, now);
  const { rows, pagination } = await runListQuery(WhatsAppConversation, {
    filter: { $and: [...parts, tabs[query.view ?? 'all'] ?? {}] },
    sort: { lastMessageAt: -1, _id: -1 },
    page: query.page,
    pageSize: query.pageSize,
  });
  const countKeys = ['all', 'unread', 'needs_reply', 'window_open', 'unknown'];
  const counts = await Promise.all(
    countKeys.map((key) => WhatsAppConversation.countDocuments({ $and: [...parts, tabs[key]] })),
  );
  const names = await namesOf(rows);
  return {
    items: rows.map((row) => toView(row, names, now)),
    pagination,
    counts: Object.fromEntries(countKeys.map((key, index) => [key, counts[index]])),
  };
}

async function messageViews(messages) {
  const replyIds = messages.map((item) => item.replyToId).filter(Boolean);
  const [senders, replies] = await Promise.all([
    User.find({ _id: { $in: messages.map((item) => item.sentBy).filter(Boolean) } })
      .select('name')
      .lean(),
    replyIds.length
      ? WhatsAppMessage.find({ _id: { $in: replyIds } })
          .select('direction type text media.fileName sentBy')
          .lean()
      : [],
  ]);
  const senderNames = new Map(senders.map((user) => [String(user._id), user.name]));
  const replyById = new Map(replies.map((item) => [String(item._id), item]));
  return Promise.all(
    messages.map(async (message) => {
      const reply = message.replyToId ? replyById.get(String(message.replyToId)) : null;
      return {
        id: String(message._id),
        direction: message.direction,
        type: message.type,
        text: message.text ?? '',
        templateName: message.templateName ?? null,
        status: message.status,
        error: message.errorMessage ?? null,
        sentBy: message.sentBy ? (senderNames.get(String(message.sentBy)) ?? null) : null,
        sentAt: message.sentAt,
        media: message.media
          ? {
              url: message.media.url ? await toReadableUrl(message.media.url) : null,
              mimeType: message.media.mimeType ?? null,
              fileName: message.media.fileName ?? null,
              size: message.media.size ?? null,
              status: message.media.status,
            }
          : null,
        replyTo: reply
          ? {
              id: String(reply._id),
              direction: reply.direction,
              type: reply.type,
              text: (reply.text ?? '').slice(0, 200),
              fileName: reply.media?.fileName ?? null,
            }
          : null,
        reaction: message.reaction ? { emoji: message.reaction.emoji } : null,
        location: message.location ?? null,
        // A message can be answered (quoted) only when WhatsApp knows it.
        canReply: Boolean(message.wamid) && message.type !== 'reaction',
      };
    }),
  );
}

/**
 * One conversation with a page of its messages, oldest first. The first page marks it read.
 * @param {{ before?: Date, limit?: number }} [query]  Validated: messages older than `before`
 */
export async function getConversation(actor, conversationId, query = {}, now = new Date()) {
  const conversation = await loadConversation(actor, conversationId);
  const limit = query.limit ?? THREAD_PAGE_SIZE;
  const found = await WhatsAppMessage.find({
    conversationId: conversation._id,
    ...(query.before ? { sentAt: { $lt: query.before } } : {}),
  })
    .sort({ sentAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();
  const hasMore = found.length > limit;
  const messages = found.slice(0, limit).reverse();
  if (!query.before && conversation.unreadCount > 0) {
    await WhatsAppConversation.updateOne({ _id: conversation._id }, { $set: { unreadCount: 0 } });
    announce();
  }
  return {
    ...toView({ ...conversation, unreadCount: 0 }, await namesOf([conversation]), now),
    messages: await messageViews(messages),
    hasMore,
    permissions: {
      canSend: can(actor, 'create', { feature: FEATURE }),
      canAssign: can(actor, 'edit', { feature: FEATURE }),
    },
  };
}

/** Mark a conversation as read (the screen calls it when new messages arrive in an open chat). */
export async function markConversationRead(actor, conversationId) {
  const conversation = await loadConversation(actor, conversationId);
  if (conversation.unreadCount > 0) {
    await WhatsAppConversation.updateOne({ _id: conversation._id }, { $set: { unreadCount: 0 } });
    announce();
  }
  return { read: true };
}

// ── Starting and linking ────────────────────────────────────────────────────────────────────

async function loadContactForWhatsApp(actor, contactId) {
  const contact = await Contact.findOne({ _id: contactId, ...NOT_DELETED }).lean();
  if (!contact) throw notFound('Contact not found');
  await loadAccountForAction(actor, contact.accountId, 'view').catch(() => {
    throw notFound('Contact not found');
  });
  return contact;
}

/**
 * The conversation with a person of a company, made when there is none (the WhatsApp button
 * in Accounts → People). A new one starts with a template: we may not write first otherwise.
 * @returns {Promise<{ conversationId: string, created: boolean }>}
 */
export async function openConversationForContact(actor, contactId) {
  const contact = await loadContactForWhatsApp(actor, contactId);
  const waId = String(contact.phone_number ?? contact.alt_phone_number ?? '').replace(/\D/g, '');
  if (waId.length < 8) throw badRequest('This person has no complete phone number.');
  const existing = await WhatsAppConversation.findOne({ waId }).lean();
  if (existing) {
    if (!existing.contactId) {
      // A number that wrote before it was in the CRM: it is this person.
      await WhatsAppConversation.updateOne(
        { _id: existing._id },
        { $set: await linksForContact(contact) },
      );
      announce();
      return { conversationId: String(existing._id), created: false };
    }
    const isVisible = await WhatsAppConversation.exists({
      $and: [{ _id: existing._id }, await visibleConversations(actor)],
    });
    if (!isVisible) {
      throw conflict(
        'This number already has a WhatsApp chat that belongs to another person in the CRM. Ask a manager.',
      );
    }
    return { conversationId: String(existing._id), created: false };
  }
  const created = await WhatsAppConversation.findOneAndUpdate(
    { waId },
    { $setOnInsert: { waId, ...(await linksForContact(contact)) } },
    { upsert: true, returnDocument: 'after' },
  ).lean();
  announce();
  return { conversationId: String(created._id), created: true };
}

/**
 * Say which person of the CRM a conversation is with (an unknown number, or a wrong link).
 * Its earlier messages are put on that person's timeline.
 * @param {{ contactId: string }} body  Validated
 */
export async function linkConversation(actor, conversationId, { contactId }, context = {}) {
  const conversation = await loadConversation(actor, conversationId, 'edit');
  const contact = await loadContactForWhatsApp(actor, contactId);
  const links = await linksForContact(contact);
  // The person it is assigned to stays; a conversation of nobody goes to the contact's owner.
  if (conversation.assignedTo) delete links.assignedTo;
  await WhatsAppConversation.updateOne(
    { _id: conversation._id },
    { $set: links, ...(links.opportunityId ? {} : { $unset: { opportunityId: '' } }) },
  );
  const linked = { ...conversation, ...links };
  if (!links.opportunityId) delete linked.opportunityId;
  const messages = await WhatsAppMessage.find({
    conversationId: conversation._id,
    type: { $ne: 'reaction' },
  })
    .sort({ sentAt: 1 })
    .limit(500)
    .lean();
  for (const message of messages) await onTimeline(linked, message, contact.name);
  await writeAudit({
    actor,
    action: 'whatsapp.linked',
    entityType: 'whatsapp_conversations',
    entityId: conversation._id,
    oldValue: { contactId: conversation.contactId ? String(conversation.contactId) : null },
    newValue: { contactId: String(contact._id) },
    requestId: context.requestId,
  });
  announce();
  return { linked: true };
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

// ── Sending ─────────────────────────────────────────────────────────────────────────────────

/** Refuse what WhatsApp or the customer does not allow, before anything goes out. */
async function assertMayWrite(conversation, { needsWindow }, now) {
  if (await isOptedOut('whatsapp', phoneOf(conversation))) {
    throw createAppError(
      'WHATSAPP_OPTED_OUT',
      409,
      'This person opted out of WhatsApp messages. Please call them instead.',
    );
  }
  if (needsWindow && !isWindowOpen(conversation, now)) {
    throw createAppError(
      'WHATSAPP_WINDOW_CLOSED',
      409,
      'The customer last wrote more than 24 hours ago. WhatsApp then allows only an approved template message.',
    );
  }
}

/** The message being answered, when it belongs to this conversation and WhatsApp knows it. */
async function replyTarget(conversation, replyToId) {
  if (!replyToId) return null;
  const target = await WhatsAppMessage.findOne({
    _id: replyToId,
    conversationId: conversation._id,
  })
    .select('_id wamid')
    .lean();
  return target?.wamid ? target : null;
}

/**
 * Send one message and keep it: on success with Meta's id, on failure as "failed" with the
 * reason (and the error is thrown on). The conversation, the timeline and the audit log follow.
 * @param {object} draft  What is kept: type, text, templateName, media, replyToId
 * @param {() => Promise<{ wamid: string }>} transmit  The call to WhatsApp
 */
async function sendAndKeep(actor, conversation, draft, transmit, context, now) {
  const base = {
    conversationId: conversation._id,
    direction: 'outbound',
    ...draft,
    text: String(draft.text ?? '').slice(0, 5000),
    sentBy: actor._id,
    sentAt: now,
  };
  let sent;
  try {
    sent = await transmit();
  } catch (error) {
    // Kept as a failed message, so the conversation shows what was tried.
    await WhatsAppMessage.create({
      ...base,
      status: 'failed',
      errorCode: error?.providerCode,
      errorMessage: String(error?.message ?? 'Not sent').slice(0, 300),
    });
    announce();
    throw error;
  }
  const message = await WhatsAppMessage.create({
    ...base,
    wamid: sent.wamid || undefined,
    status: 'sent',
  });
  await WhatsAppConversation.updateOne(
    { _id: conversation._id },
    {
      $set: {
        snippet: snippetOf(message).slice(0, 300),
        lastMessageAt: now,
        lastOutboundAt: now,
        lastDirection: 'outbound',
        // The first person who answers a conversation nobody had takes it.
        ...(conversation.assignedTo ? {} : { assignedTo: actor._id }),
      },
    },
  );
  await onTimeline(conversation, message, await displayNameOf(conversation));
  await writeAudit({
    actor,
    action: 'whatsapp.sent',
    entityType: 'whatsapp_conversations',
    entityId: conversation._id,
    newValue: {
      to: phoneOf(conversation),
      type: message.type,
      ...(message.templateName ? { template: message.templateName } : {}),
      characters: message.text.length,
    },
    requestId: context.requestId,
  });
  announce();
  return message;
}

/**
 * Answer a customer with a plain text. Only inside the 24 hours after their last message.
 * @param {{ text: string, replyToId?: string }} body  Validated
 */
export async function sendText(actor, conversationId, body, context = {}, now = new Date()) {
  const conversation = await loadConversation(actor, conversationId, 'create');
  await assertMayWrite(conversation, { needsWindow: true }, now);
  const target = await replyTarget(conversation, body.replyToId);
  await sendAndKeep(
    actor,
    conversation,
    { type: 'text', text: body.text, ...(target ? { replyToId: target._id } : {}) },
    () => sendWhatsAppText(conversation.waId, body.text, target?.wamid),
    context,
    now,
  );
  return getConversation(actor, conversation._id, {}, now);
}

/** A file in WhatsApp's store, kept with us too. Shared by uploads and library documents. */
async function sendFileOut(actor, conversation, file, options, context, now) {
  const { kind, mimeType } = classifyFile({
    mimeType: file.mimeType,
    fileName: file.fileName,
    size: file.buffer.length,
  });
  const target = await replyTarget(conversation, options.replyToId);
  const url =
    file.url ??
    (isStorageConfigured()
      ? await storeWhatsAppFile(conversation._id, { ...file, mimeType })
      : undefined);
  const caption = (options.caption ?? '').trim();
  await sendAndKeep(
    actor,
    conversation,
    {
      type: kind,
      text: caption,
      media: {
        url,
        mimeType,
        fileName: file.fileName,
        size: file.buffer.length,
        status: url ? 'ready' : 'failed',
      },
      ...(target ? { replyToId: target._id } : {}),
    },
    async () => {
      const mediaId = await uploadWhatsAppMedia({ ...file, mimeType });
      return sendWhatsAppMedia(
        conversation.waId,
        { kind, mediaId, caption, fileName: file.fileName },
        target?.wamid,
      );
    },
    context,
    now,
  );
}

/**
 * Send a file the person uploaded (a picture, video, voice message or document).
 * @param {{ buffer: Buffer, mimetype: string, originalname: string }} upload  From multer
 * @param {{ caption?: string, replyToId?: string }} body  Validated
 */
export async function sendFile(
  actor,
  conversationId,
  upload,
  body,
  context = {},
  now = new Date(),
) {
  const conversation = await loadConversation(actor, conversationId, 'create');
  await assertMayWrite(conversation, { needsWindow: true }, now);
  await sendFileOut(
    actor,
    conversation,
    {
      buffer: upload.buffer,
      mimeType: upload.mimetype,
      fileName: cleanFileName(upload.originalname),
    },
    body,
    context,
    now,
  );
  return getConversation(actor, conversation._id, {}, now);
}

/** A document of the Documents library, read from S3, when the person may see documents. */
async function libraryFile(actor, documentId) {
  if (!can(actor, 'view', { feature: 'documents' })) throw notFound('Document not found');
  const document = await Document.findOne({ _id: documentId, ...NOT_DELETED }).lean();
  const key = document ? keyFromUrl(document.url) : null;
  const buffer = key ? await readObject(key) : null;
  if (!buffer) throw notFound('Document not found');
  return {
    buffer,
    mimeType: document.mimeType,
    fileName: document.filename,
    url: document.url,
  };
}

/**
 * Send a document of the library (a proposal, a brochure) without uploading it again.
 * @param {{ documentId: string, caption?: string, replyToId?: string }} body  Validated
 */
export async function sendLibraryDocument(
  actor,
  conversationId,
  body,
  context = {},
  now = new Date(),
) {
  const conversation = await loadConversation(actor, conversationId, 'create');
  await assertMayWrite(conversation, { needsWindow: true }, now);
  const file = await libraryFile(actor, body.documentId);
  await sendFileOut(actor, conversation, file, body, context, now);
  return getConversation(actor, conversation._id, {}, now);
}

// ── Templates ───────────────────────────────────────────────────────────────────────────────

/** The places of a template text, in order: ["1", "2"] or ["first_name", "company"]. */
function placesOf(text) {
  return [...new Set([...String(text ?? '').matchAll(/{{\s*([\w]+)\s*}}/g)].map((m) => m[1]))];
}

/** A template as the screen needs it, and whether the CRM can send it. */
function readTemplate(template) {
  const part = (type) => (template.components ?? []).find((item) => item.type === type);
  const header = part('HEADER');
  const body = part('BODY');
  const footer = part('FOOTER');
  const buttons = part('BUTTONS')?.buttons ?? [];
  const places = placesOf(body?.text);
  let unsupported = null;
  if (template.status !== 'APPROVED') unsupported = 'Not approved by Meta yet.';
  else if (template.category === 'AUTHENTICATION') unsupported = 'A sign-in code template.';
  else if (header?.format === 'LOCATION') unsupported = 'Its header is a location.';
  else if (header?.format === 'TEXT' && placesOf(header.text).length)
    unsupported = 'Its header has a variable.';
  else if (buttons.some((button) => /{{/.test(button.url ?? '')))
    unsupported = 'A button has a variable link.';
  return {
    name: template.name,
    language: template.language,
    category: template.category,
    status: template.status,
    bodyText: body?.text ?? '',
    variables: places,
    isNamed: places.some((place) => !/^\d+$/.test(place)),
    headerType: header?.format ?? null,
    headerText: header?.format === 'TEXT' ? (header.text ?? null) : null,
    footerText: footer?.text ?? null,
    buttons: buttons.map((button) => ({ type: button.type, text: button.text })),
    canSend: unsupported === null,
    unsupported,
  };
}

/**
 * The templates of the WhatsApp Business Account (cached for 10 minutes).
 * @param {{ all?: boolean, refresh?: boolean }} [options]  all: also the ones the CRM cannot send
 */
export async function listTemplates({ all = false, refresh = false } = {}) {
  if (!isWhatsAppConfigured()) return [];
  if (refresh) await invalidate(TEMPLATES_CACHE_KEY);
  const templates = await getOrSet(TEMPLATES_CACHE_KEY, TEMPLATES_CACHE_SECONDS, async () =>
    (await fetchWhatsAppTemplates()).map(readTemplate),
  );
  const sorted = [...templates].sort((a, b) => a.name.localeCompare(b.name));
  return all ? sorted : sorted.filter((template) => template.canSend);
}

/** The filled text of a template, as it is kept and shown. */
function filledText(template, values) {
  return template.bodyText.replace(/{{\s*([\w]+)\s*}}/g, (match, place) => values[place] ?? match);
}

/** A header file of a template: a file uploaded to this conversation, or a library document. */
async function headerFile(actor, conversation, header) {
  if (header.documentId) return libraryFile(actor, header.documentId);
  const key = keyFromUrl(header.url);
  if (!key || !key.startsWith(`whatsapp/${conversation._id}/`)) {
    throw badRequest('Upload the header file again.');
  }
  const buffer = await readObject(key);
  if (!buffer) throw badRequest('Upload the header file again.');
  return { buffer, mimeType: header.mimeType, fileName: header.fileName, url: header.url };
}

/**
 * Send an approved template: the way to write first, or after the 24 hours.
 * @param {{ templateName: string, language: string, values: Record<string, string>,
 *           header?: { url?: string, documentId?: string, fileName?: string, mimeType?: string } }} body
 *        values: the text for each variable ({ "1": "Rajesh" } or { first_name: "Rajesh" })
 */
export async function sendTemplate(actor, conversationId, body, context = {}, now = new Date()) {
  const conversation = await loadConversation(actor, conversationId, 'create');
  await assertMayWrite(conversation, { needsWindow: false }, now);
  const template = (await listTemplates()).find(
    (item) => item.name === body.templateName && item.language === body.language,
  );
  if (!template) throw badRequest('This template is not approved or no longer exists.');
  const values = Object.fromEntries(
    template.variables.map((place) => [place, String(body.values?.[place] ?? '').trim()]),
  );
  const missing = template.variables.filter((place) => !values[place]);
  if (missing.length) {
    throw badRequest(`Fill all ${template.variables.length} variable(s) of the template.`);
  }
  const mediaKind = { IMAGE: 'image', VIDEO: 'video', DOCUMENT: 'document' }[template.headerType];
  if (mediaKind && !body.header) {
    throw badRequest(
      `This template needs ${mediaKind === 'image' ? 'an image' : `a ${mediaKind}`}: add one.`,
    );
  }
  const file = mediaKind ? await headerFile(actor, conversation, body.header) : null;
  if (file) {
    const { kind } = classifyFile({
      mimeType: file.mimeType,
      fileName: file.fileName,
      size: file.buffer.length,
    });
    if (kind !== mediaKind) {
      throw badRequest(
        `This template's header must be ${mediaKind === 'image' ? 'an image' : `a ${mediaKind}`}.`,
      );
    }
  }
  const params = template.variables.map((place) =>
    template.isNamed ? { name: place, text: values[place] } : values[place],
  );
  const text = filledText(template, values);
  await sendAndKeep(
    actor,
    conversation,
    {
      type: 'template',
      templateName: template.name,
      text,
      ...(file
        ? {
            media: {
              url: file.url,
              mimeType: file.mimeType,
              fileName: file.fileName,
              size: file.buffer.length,
              status: 'ready',
            },
          }
        : {}),
    },
    async () => {
      const header = file
        ? {
            kind: mediaKind,
            mediaId: await uploadWhatsAppMedia(file),
            fileName: file.fileName,
          }
        : undefined;
      return sendWhatsAppTemplate(conversation.waId, {
        name: template.name,
        language: template.language,
        params,
        header,
      });
    },
    context,
    now,
  );
  return getConversation(actor, conversation._id, {}, now);
}

/**
 * Keep a file for a template header in this conversation's folder (step one of sending a
 * template with a picture, video or document header).
 * @returns {Promise<{ url: string, fileName: string, mimeType: string, size: number }>}
 */
export async function uploadTemplateHeader(actor, conversationId, upload) {
  const conversation = await loadConversation(actor, conversationId, 'create');
  if (!isStorageConfigured()) throw badRequest('File storage is not set up.');
  const fileName = cleanFileName(upload.originalname);
  const { mimeType } = classifyFile({
    mimeType: upload.mimetype,
    fileName,
    size: upload.buffer.length,
  });
  const url = await storeWhatsAppFile(conversation._id, {
    buffer: upload.buffer,
    mimeType,
    fileName,
  });
  return { url, fileName, mimeType, size: upload.buffer.length };
}

/**
 * Send an approved template to a number: used by bulk sending. The message is kept in that
 * number's conversation (made when there is none) and on the timeline. The caller has checked
 * that the actor may write to this person and that the number is not opted out.
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
  const conversation = await conversationForNumber(waId);
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
    {
      $set: {
        snippet: text.slice(0, 300),
        lastMessageAt: now,
        lastOutboundAt: now,
        lastDirection: 'outbound',
      },
    },
  );
  await onTimeline(conversation, saved, await displayNameOf(conversation));
  announce();
  return { conversationId: String(conversation._id) };
}
