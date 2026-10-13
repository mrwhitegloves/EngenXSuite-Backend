import { env } from '../config/env.js';
import { JOB_NAMES } from '../constants/jobNames.js';
import { SOCKET_EVENTS } from '../constants/socketEvents.js';
import { logger } from '../infra/logger.js';
import { enqueue } from '../infra/queues.js';
import { emitToAll } from '../infra/realtime.js';
import { isStorageConfigured, toReadableUrl, uploadObject } from '../infra/storage.js';
import {
  dialXml,
  downloadRecording,
  emptyXml,
  getCallRecord,
  isPlivoConfigured,
  missingPlivoSettings,
  ourNumber,
  plivoUrl,
  speakXml,
  startCall as placeCall,
} from '../integrations/plivo/client.js';
import { writeAudit } from '../lib/audit.js';
import { can, getScope } from '../lib/can.js';
import { badRequest, conflict, createAppError, forbidden, notFound } from '../lib/errors.js';
import { normalizePhone } from '../lib/phone.js';
import { buildFilter, buildSort, containsPattern, runListQuery } from '../lib/queryBuilder.js';
import { scopeFilter } from '../lib/scopeFilter.js';
import { systemActor } from '../lib/systemActor.js';
import { Account } from '../models/account.model.js';
import { Call } from '../models/call.model.js';
import { CallTranscript } from '../models/callTranscript.model.js';
import { Contact } from '../models/contact.model.js';
import { Opportunity } from '../models/opportunity.model.js';
import { Settings } from '../models/settings.model.js';
import { User } from '../models/user.model.js';
import { loadAccountForAction } from './accounts.service.js';
import { recordActivity, relinkActivity } from './activities.service.js';
import { notify } from './notifications.service.js';
import { loadLeadForAction } from './opportunities.service.js';
import { createTask } from './tasks.service.js';
import { registerWebhookProcessor } from './webhooks.service.js';

// Phone calls through Plivo (REQ-CAL-001 … 004, 008, 009).
//
// Click-to-call: the person presses Call → Plivo rings THEIR OWN phone (the number on their
// user record) → when they pick up, Plivo asks our "connect" webhook and we answer "dial the
// customer". The customer sees our Plivo number, never the agent's own.
//
// Inbound: a customer calls our Plivo number → Plivo asks our "inbound" webhook → the caller is
// matched by phone number, and we answer "dial the person who looks after them" (the owner of
// their open lead, else of the contact, else of the company, else the default person from
// Settings → Calls). Nobody picks up: a missed call, a notification and a call-back task.
//
// Every webhook goes through the common receiver (verified, stored once, handled by a job).
// The job is safe to run twice: a call is found by its id, and its timeline entry, notification
// and task are each made once.

const FEATURE = 'calls';
// For can(): the "owner" of a call is the agent.
const OWNERSHIP = { ownerField: 'userId' };
const NOT_DELETED = { deletedAt: null };
const CALL_BACK_DUE_MS = 30 * 60 * 1000;
// Inbound: how long the first person's phone rings before the next person is tried.
const FIRST_RING_SEC = 25;
const SECOND_RING_SEC = 30;
const DEFAULT_CONSENT = 'This call may be recorded for quality and training.';
const NOBODY_AVAILABLE =
  'Thank you for calling. Nobody is available right now. We will call you back shortly.';
const announce = () => emitToAll(SOCKET_EVENTS.callsChanged);

async function readSettings() {
  const settings = await Settings.findOne({ key: 'app' }).select('calls').lean();
  return {
    recordingEnabled: settings?.calls?.recordingEnabled ?? false,
    announcementEnabled: settings?.calls?.announcementEnabled ?? true,
    consentText: settings?.calls?.consentText || DEFAULT_CONSENT,
    defaultInboundUserId: settings?.calls?.defaultInboundUserId ?? null,
  };
}

/** A user's own phone in the international form; null when they have none (or it is not one). */
async function phoneOfUser(userId) {
  if (!userId) return null;
  const user = await User.findOne({ _id: userId, status: 'active' }).select('phone').lean();
  return normalizePhone(user?.phone);
}

// ── Settings ────────────────────────────────────────────────────────────────────────────────

/** What Settings → Calls shows. */
export async function getCallSettings() {
  const [settings, users] = await Promise.all([
    readSettings(),
    User.find({ status: 'active' }).select('name phone').sort({ name: 1 }).lean(),
  ]);
  return {
    recordingEnabled: settings.recordingEnabled,
    announcementEnabled: settings.announcementEnabled,
    consentText: settings.consentText,
    defaultInboundUserId: settings.defaultInboundUserId
      ? String(settings.defaultInboundUserId)
      : null,
    // Recordings are kept in file storage: without it a recorded call is not saved.
    canStoreRecordings: isStorageConfigured(),
    setup: {
      isConfigured: isPlivoConfigured(),
      missing: missingPlivoSettings(),
      // What to enter in the Plivo application of our number.
      inboundPath: '/api/webhooks/plivo/inbound',
      hangupPath: '/api/webhooks/plivo/hangup',
    },
    // Who can take calls: only someone with a phone number on their user record.
    users: users.map((user) => ({
      id: String(user._id),
      name: user.name,
      hasPhone: Boolean(normalizePhone(user.phone)),
    })),
  };
}

/**
 * @param {{ recordingEnabled?: boolean, consentText?: string,
 *           defaultInboundUserId?: string | null }} changes  Already validated
 */
export async function updateCallSettings(actor, changes, context = {}) {
  if (changes.defaultInboundUserId && !(await phoneOfUser(changes.defaultInboundUserId))) {
    throw badRequest('Choose an active user who has a phone number', [
      { field: 'defaultInboundUserId' },
    ]);
  }
  const set = Object.fromEntries(
    Object.entries(changes).map(([field, value]) => [`calls.${field}`, value]),
  );
  const settings = await Settings.findOneAndUpdate(
    { key: 'app' },
    { $set: set },
    { returnDocument: 'after' },
  ).lean();
  if (!settings) throw badRequest('The settings are not set up yet. Run the seed first.');
  await writeAudit({
    actor,
    action: 'settings.calls_updated',
    entityType: 'settings',
    entityId: settings._id,
    newValue: changes,
    requestId: context.requestId,
  });
  announce();
  return getCallSettings();
}

// ── Views ───────────────────────────────────────────────────────────────────────────────────

async function toViews(calls, actor) {
  const ids = (field) => [
    ...new Set(
      calls
        .map((call) => call[field])
        .filter(Boolean)
        .map(String),
    ),
  ];
  const [users, contacts, accounts, leads, transcripts] = await Promise.all([
    User.find({ _id: { $in: [...ids('userId'), ...ids('answeredByUserId')] } })
      .select('name')
      .lean(),
    Contact.find({ _id: { $in: ids('contactId') } })
      .select('name')
      .lean(),
    Account.find({ _id: { $in: ids('accountId') } })
      .select('name')
      .lean(),
    Opportunity.find({ _id: { $in: ids('opportunityId') } })
      .select('name')
      .lean(),
    CallTranscript.find({ callId: { $in: calls.map((call) => call._id) } })
      .select('callId')
      .lean(),
  ]);
  const withText = new Set(transcripts.map((item) => String(item.callId)));
  const named = (list, id) => {
    const item = id && list.find((entry) => String(entry._id) === String(id));
    return item ? { id: String(item._id), name: item.name } : null;
  };
  return calls.map((call) => {
    const record = { feature: FEATURE, record: call, ...OWNERSHIP };
    return {
      id: String(call._id),
      direction: call.direction,
      status: call.status,
      // The other side's number: the customer's.
      number: call.direction === 'outbound' ? call.toNumber : call.fromNumber,
      startedAt: call.startedAt ?? call.createdAt,
      durationSec: call.durationSec ?? null,
      hangupCause: call.hangupCause ?? null,
      // What Plivo charged, in the currency of the Plivo account.
      cost: call.cost ?? null,
      costInr: call.cost ? Math.round(call.cost * PLIVO_USD_TO_INR * 100) / 100 : null,
      outcome: call.outcome ?? null,
      user: named(users, call.userId),
      // Inbound: set when someone else picked up because the first person did not.
      answeredBy:
        call.answeredByUserId && String(call.answeredByUserId) !== String(call.userId)
          ? named(users, call.answeredByUserId)
          : null,
      contact: named(contacts, call.contactId),
      account: named(accounts, call.accountId),
      lead: named(leads, call.opportunityId),
      opportunityId: call.opportunityId ? String(call.opportunityId) : null,
      hasRecording: Boolean(call.recordingUrl),
      // The text of the call exists (made from the recording by a person's request).
      hasTranscript: withText.has(String(call._id)),
      permissions: {
        // The recording and the outcome follow the "calls" permission (own, team, all).
        canPlayRecording: Boolean(call.recordingUrl) && can(actor, 'view', record),
        canEdit: can(actor, 'edit', record),
      },
    };
  });
}

// ── Click-to-call ───────────────────────────────────────────────────────────────────────────

/**
 * Call a contact: ring the acting person's own phone, then join the contact.
 * @param {{ contactId: string, opportunityId?: string }} data  Already validated
 */
export async function startCall(actor, { contactId, opportunityId }, context = {}) {
  if (!isPlivoConfigured()) {
    throw createAppError('PLIVO_NOT_CONFIGURED', 503, 'Calling is not set up yet.');
  }
  const contact = await Contact.findOne({ _id: contactId, ...NOT_DELETED }).lean();
  if (!contact) throw notFound('Contact not found');
  // The contact is reached through a lead the person may see, or through its company.
  if (opportunityId) {
    const lead = await loadLeadForAction(actor, opportunityId, 'view');
    if (String(lead.accountId) !== String(contact.accountId)) throw notFound('Contact not found');
  } else {
    await loadAccountForAction(actor, contact.accountId, 'view').catch(() => {
      throw notFound('Contact not found');
    });
  }
  if (contact.consent?.doNotCall) {
    throw conflict(`${contact.name} asked not to be called.`);
  }
  const customerPhone = contact.phone_number ?? contact.alt_phone_number;
  if (!customerPhone) throw badRequest(`${contact.name} has no phone number.`);
  const myPhone = await phoneOfUser(actor._id);
  if (!myPhone) {
    throw badRequest(
      'Your own phone number is missing or not valid. It is set on the Users screen; the call rings that phone first.',
    );
  }

  const call = await Call.create({
    direction: 'outbound',
    fromNumber: ourNumber(),
    toNumber: customerPhone,
    status: 'initiated',
    startedAt: new Date(),
    userId: actor._id,
    contactId: contact._id,
    accountId: contact.accountId,
    opportunityId: opportunityId ?? undefined,
  });
  try {
    const { requestUuid } = await placeCall({
      to: myPhone,
      answerUrl: plivoUrl('connect', { call: call._id }),
      hangupUrl: plivoUrl('hangup', { call: call._id }),
    });
    await Call.updateOne({ _id: call._id }, { $set: { plivoCallUuid: requestUuid } });
  } catch (error) {
    await Call.updateOne(
      { _id: call._id },
      { $set: { status: 'failed', endedAt: new Date(), hangupCause: 'could_not_start' } },
    );
    throw error;
  }
  await writeAudit({
    actor,
    action: 'call.started',
    entityType: 'calls',
    entityId: call._id,
    newValue: { contactId: String(contact._id), direction: 'outbound' },
    requestId: context.requestId,
  });
  announce();
  return (await toViews([await Call.findById(call._id).lean()], actor))[0];
}

/**
 * The calls of one lead, company or contact, newest first. Whoever may see that record sees
 * that the calls happened; a recording needs the "calls" permission for that call.
 * @param {{ opportunityId?: string, accountId?: string, contactId?: string, page: number,
 *           pageSize: number }} query  Validated: exactly one of the three ids
 */
export async function listCalls(actor, query) {
  let filter;
  if (query.opportunityId) {
    const lead = await loadLeadForAction(actor, query.opportunityId, 'view');
    filter = { opportunityId: lead._id };
  } else if (query.accountId) {
    const account = await loadAccountForAction(actor, query.accountId, 'view');
    filter = { accountId: account._id };
  } else if (query.contactId) {
    const contact = await Contact.findOne({ _id: query.contactId, ...NOT_DELETED }).lean();
    if (!contact) throw notFound('Contact not found');
    await loadAccountForAction(actor, contact.accountId, 'view').catch(() => {
      throw notFound('Contact not found');
    });
    filter = { contactId: contact._id };
  } else {
    // Every call I may see: mine, my team's or everyone's, by the "calls" permission.
    filter = buildFilter({
      scope: scopeFilter(actor, FEATURE, OWNERSHIP),
      equals: {
        direction: query.direction,
        status: query.status,
        userId: query.userId,
        outcome: query.outcome,
      },
      dates: { field: 'startedAt', query },
      extra: [
        query.linked === 'no' ? { contactId: null } : {},
        query.linked === 'yes' ? { contactId: { $ne: null } } : {},
        query.recording === 'yes' ? { recordingUrl: { $nin: [null, ''] } } : {},
        await searchFilter(query.search),
      ],
    });
  }
  const { rows, pagination } = await runListQuery(Call, {
    filter,
    sort: buildSort(query.sort, CALL_SORT_FIELDS, '-startedAt'),
    page: query.page,
    pageSize: query.pageSize,
    select: '-plivo',
  });
  return { items: await toViews(rows, actor), pagination };
}

const CALL_SORT_FIELDS = { startedAt: 'startedAt', durationSec: 'durationSec', cost: 'cost' };

/**
 * Calls that match a search text: by the number (digits), or by the name of the person, the
 * company or the lead. The scope is applied by the caller, so this only narrows.
 */
async function searchFilter(text) {
  if (!text) return {};
  const pattern = containsPattern(text);
  const digits = text.replace(/\D/g, '');
  const [contacts, accounts, leads] = await Promise.all([
    Contact.find({ name: pattern }).select('_id').limit(200).lean(),
    Account.find({ name: pattern }).select('_id').limit(200).lean(),
    Opportunity.find({ name: pattern }).select('_id').limit(200).lean(),
  ]);
  const pick = (rows) => rows.map((row) => row._id);
  return {
    $or: [
      { contactId: { $in: pick(contacts) } },
      { accountId: { $in: pick(accounts) } },
      { opportunityId: { $in: pick(leads) } },
      ...(digits.length >= 3
        ? [{ fromNumber: containsPattern(digits) }, { toNumber: containsPattern(digits) }]
        : []),
    ],
  };
}

/** The people whose calls the actor may see: for the "Called by" filter of the call log. */
export async function getCallFormOptions(actor) {
  const scope = getScope(actor, FEATURE, 'view');
  let filter = { _id: actor._id };
  if (scope === 'all') filter = { status: 'active' };
  else if (scope === 'team') filter = { _id: { $in: [actor._id, ...(actor.teamUserIds ?? [])] } };
  const users = await User.find(filter).select('name').sort({ name: 1 }).lean();
  return { users: users.map((user) => ({ id: String(user._id), name: user.name })) };
}

/** Plivo writes its times as "2026-10-12 14:55:48", in UTC. */
const plivoTime = (text) => {
  const date = text ? new Date(`${String(text).replace(' ', 'T').slice(0, 19)}Z`) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
};
const inr = (dollars) =>
  Number.isFinite(Number(dollars)) && Number(dollars) > 0
    ? Math.round(Number(dollars) * PLIVO_USD_TO_INR * 100) / 100
    : 0;

/**
 * One call in full, the way Plivo's own call page shows it: its times, both sides (legs) with
 * what each lasted and cost, how it ended, and what happened step by step.
 */
export async function getCallDetail(actor, callId) {
  const call = await loadCallForAction(actor, callId, 'view');
  const [view] = await toViews([call], actor);
  const { dial, hangup, aLeg, bLeg, settledAt } = call.plivo ?? {};
  const started = plivoTime(hangup?.StartTime) ?? call.startedAt ?? call.createdAt;
  const answered = plivoTime(hangup?.AnswerTime) ?? call.answeredAt ?? null;
  const ended = plivoTime(hangup?.EndTime) ?? call.endedAt ?? null;
  const isOutbound = call.direction === 'outbound';
  // The company number, as this call itself has it (the setting may have changed since).
  const us = isOutbound ? call.fromNumber : call.toNumber;

  // The two sides of the call, as Plivo lists them ("Self" and "Child").
  const legs = [
    {
      relation: 'First side',
      // Click-to-call: our number rings our own person. Inbound: the customer rings our number.
      from: isOutbound ? us : call.fromNumber,
      to: isOutbound ? (hangup?.To ? `+${String(hangup.To).replace(/\D/g, '')}` : null) : us,
      who: isOutbound ? 'Our person’s phone' : 'The customer',
      durationSec: aLeg?.durationSec ?? (Number(hangup?.Duration) || null),
      costInr: inr(aLeg?.cost ?? hangup?.TotalCost),
      hangupCause: aLeg?.hangupCause ?? hangup?.HangupCauseName ?? hangup?.HangupCause ?? null,
    },
    ...(dial
      ? [
          {
            relation: 'Second side',
            from: us,
            to: dial.DialBLegTo ? `+${String(dial.DialBLegTo).replace(/\D/g, '')}` : null,
            who: isOutbound ? 'The customer' : 'Our person’s phone',
            durationSec: bLeg?.durationSec ?? null,
            costInr: inr(bLeg?.cost),
            hangupCause: bLeg?.hangupCause ?? dial.DialHangupCause ?? null,
          },
        ]
      : []),
  ];

  // What happened, in order.
  const events = [
    {
      at: call.createdAt,
      what: isOutbound ? 'The call was started from the CRM' : 'The call came in',
    },
    started && {
      at: started,
      what: isOutbound
        ? 'Plivo started ringing our person’s phone'
        : 'Plivo answered and rang our person’s phone',
    },
    answered && {
      at: answered,
      what: isOutbound
        ? 'Our person picked up; the customer was dialled'
        : 'The first side was connected',
    },
    dial && {
      at: ended ?? call.endedAt,
      what: `The second side ended as: ${String(dial.DialStatus ?? 'unknown')}`,
    },
    ended && {
      at: ended,
      what: `The call ended${hangup?.HangupSource ? ` (hung up by: ${hangup.HangupSource})` : ''}`,
    },
    call.recordingUrl && { at: ended ?? call.endedAt, what: 'The recording was saved' },
    settledAt && { at: settledAt, what: 'Length and charge were read from Plivo’s own record' },
  ]
    .filter((item) => item && item.at)
    .sort((a, b) => new Date(a.at) - new Date(b.at));

  return {
    ...view,
    plivoCallUuid: call.plivoCallUuid ?? null,
    fromNumber: call.fromNumber,
    toNumber: call.toNumber,
    startedAt: started,
    answeredAt: answered,
    endedAt: ended,
    // From the first ring to the pick-up.
    ringSec: started && answered ? Math.max(0, Math.round((answered - started) / 1000)) : null,
    hangupCauseName: hangup?.HangupCauseName ?? call.hangupCause ?? null,
    hangupSource: hangup?.HangupSource ?? null,
    isSettled: Boolean(settledAt),
    recordingConsentPlayed: Boolean(call.recordingConsentPlayed),
    legs,
    events,
    // Plivo's own words, for finding a fault. Only for people who manage the settings.
    raw: can(actor, 'view', { feature: 'settings' }) ? { dial, hangup, aLeg, bLeg } : null,
  };
}

/** One call for an action, by the "calls" permission; anything else is "not found". */
export async function loadCallForAction(actor, callId, action) {
  const call = await Call.findById(callId).lean();
  const record = { feature: FEATURE, record: call, ...OWNERSHIP };
  if (!call || !can(actor, 'view', record)) throw notFound('Call not found');
  if (action !== 'view' && !can(actor, action, record)) {
    throw forbidden('You do not have permission to do this with this call.');
  }
  return call;
}

/** The newest open lead of a person (or of their company) that this user may see. */
async function openLeadFor(actor, contact) {
  const leads = await Opportunity.find({
    ...NOT_DELETED,
    status: 'open',
    $or: [{ primaryContactId: contact._id }, { accountId: contact.accountId }],
  })
    .select('_id')
    .sort({ createdAt: -1 })
    .limit(5)
    .lean();
  for (const lead of leads) {
    const visible = await loadLeadForAction(actor, lead._id, 'view').catch(() => null);
    if (visible) return visible;
  }
  return null;
}

/**
 * Put a call on another person (or on nobody), and move its timeline entry with it.
 * @returns {Promise<{ contactId: unknown, accountId: unknown, opportunityId: unknown }>}
 */
async function relink(actor, call, contactId) {
  let links = { contactId: null, accountId: null, opportunityId: null };
  let who = call.direction === 'outbound' ? call.toNumber : call.fromNumber;
  if (contactId) {
    const contact = await Contact.findOne({ _id: contactId, ...NOT_DELETED }).lean();
    if (!contact) throw notFound('Contact not found');
    await loadAccountForAction(actor, contact.accountId, 'view').catch(() => {
      throw notFound('Contact not found');
    });
    const lead = await openLeadFor(actor, contact);
    links = {
      contactId: contact._id,
      accountId: contact.accountId,
      opportunityId: lead?._id ?? null,
    };
    who = contact.name;
  }
  const set = Object.fromEntries(Object.entries(links).filter(([, value]) => value));
  const unset = Object.fromEntries(
    Object.entries(links)
      .filter(([, value]) => !value)
      .map(([field]) => [field, '']),
  );
  await Call.updateOne(
    { _id: call._id },
    {
      ...(Object.keys(set).length ? { $set: set } : {}),
      ...(Object.keys(unset).length ? { $unset: unset } : {}),
    },
  );
  // A finished call has (or now gets) its entry on the timeline of the right records.
  if (call.endedAt) {
    const entry = timelineEntry({ ...call, ...links }, who);
    const moved = await relinkActivity(
      { refCollection: 'calls', refId: call._id, subtype: 'call_ended' },
      { ...links, title: entry.title },
    );
    if (!moved && contactId) await recordActivity(entry);
  }
  return links;
}

/**
 * Say what came of a call, or put it on the right person.
 * @param {{ outcome?: string | null, contactId?: string | null }} changes  Validated
 */
export async function updateCall(actor, callId, changes, context = {}) {
  const call = await loadCallForAction(actor, callId, 'edit');
  if ('outcome' in changes) {
    const { outcome } = changes;
    await Call.updateOne(
      { _id: call._id },
      outcome === null ? { $unset: { outcome: '' } } : { $set: { outcome } },
    );
    await writeAudit({
      actor,
      action: 'call.outcome_set',
      entityType: 'calls',
      entityId: call._id,
      oldValue: { outcome: call.outcome ?? null },
      newValue: { outcome },
      requestId: context.requestId,
    });
  }
  if ('contactId' in changes) {
    const links = await relink(actor, call, changes.contactId);
    await writeAudit({
      actor,
      action: 'call.relinked',
      entityType: 'calls',
      entityId: call._id,
      oldValue: { contactId: call.contactId ? String(call.contactId) : null },
      newValue: { contactId: links.contactId ? String(links.contactId) : null },
      requestId: context.requestId,
    });
  }
  announce();
  return (await toViews([await Call.findById(call._id).lean()], actor))[0];
}

/** A link to listen to a call's recording (valid for an hour). Opening it is written down. */
export async function getRecordingLink(actor, callId, context = {}) {
  const call = await loadCallForAction(actor, callId, 'view');
  if (!call.recordingUrl) throw notFound('This call has no recording.');
  await writeAudit({
    actor,
    action: 'call.recording_opened',
    entityType: 'calls',
    entityId: call._id,
    requestId: context.requestId,
  });
  return { url: await toReadableUrl(call.recordingUrl) };
}

// ── What we answer to Plivo, at once ────────────────────────────────────────────────────────

/** The recording part of a "dial" answer, when recording is switched on. */
async function recordingOptions(callId) {
  const settings = await readSettings();
  if (!settings.recordingEnabled) return {};
  const recordingUrl = plivoUrl('recording', { call: callId });
  // Recording without the announcement is a setting (Settings → Calls).
  if (!settings.announcementEnabled) return { recordingUrl };
  await Call.updateOne({ _id: callId }, { $set: { recordingConsentPlayed: true } });
  // The announcement is said to the side that is being dialled, before the two are joined.
  return { recordingUrl, consentUrl: plivoUrl('consent') };
}

/** Click-to-call: the agent picked up. "Now dial the customer." */
export async function answerConnect(callId) {
  const call = mongooseId(callId) ? await Call.findById(callId).lean() : null;
  if (!call || call.direction !== 'outbound') return emptyXml();
  return dialXml({
    number: call.toNumber,
    resultUrl: plivoUrl('dial-result', { call: call._id }),
    ...(await recordingOptions(call._id)),
  });
}

const mongooseId = (value) => /^[0-9a-fA-F]{24}$/.test(String(value ?? ''));

/** Who an inbound call is from, and whose phone should ring. */
async function matchCaller(fromNumber) {
  const contact = fromNumber
    ? await Contact.findOne({
        ...NOT_DELETED,
        $or: [{ phone_number: fromNumber }, { alt_phone_number: fromNumber }],
      })
        .sort({ createdAt: 1 })
        .lean()
    : null;
  const lead = contact
    ? await Opportunity.findOne({
        ...NOT_DELETED,
        status: 'open',
        $or: [{ primaryContactId: contact._id }, { accountId: contact.accountId }],
      })
        .sort({ createdAt: -1 })
        .lean()
    : null;
  const account = contact
    ? await Account.findById(contact.accountId).select('ownerId').lean()
    : null;
  const settings = await readSettings();
  // The first of these people who has a phone takes the call.
  const candidates = [
    lead?.ownerId,
    contact?.ownerId,
    account?.ownerId,
    settings.defaultInboundUserId,
  ];
  for (const userId of candidates) {
    const phone = await phoneOfUser(userId);
    if (phone) {
      const fallbackUserId = await fallbackFor(userId, settings.defaultInboundUserId);
      return { contact, lead, userId, phone, fallbackUserId };
    }
  }
  return { contact, lead, userId: candidates.find(Boolean) ?? null, phone: null };
}

/**
 * Who is rung when the first person does not pick up: the default person from Settings → Calls,
 * else the first person's manager. Someone else than the first person, with a phone; else nobody.
 */
async function fallbackFor(firstUserId, defaultUserId) {
  const first = await User.findById(firstUserId).select('managerId').lean();
  for (const userId of [defaultUserId, first?.managerId]) {
    if (userId && String(userId) !== String(firstUserId) && (await phoneOfUser(userId))) {
      return userId;
    }
  }
  return null;
}

/**
 * Inbound: a customer called our number. The call is written down, and Plivo is told whose
 * phone to ring (or to say that nobody is available).
 * @param {{ CallUUID?: string, From?: string, To?: string }} params  Plivo's form fields
 */
export async function answerInbound(params) {
  if (!params.CallUUID) return speakXml(NOBODY_AVAILABLE);
  const fromNumber = normalizePhone(`+${String(params.From ?? '').replace(/\D/g, '')}`);
  const { contact, lead, userId, phone, fallbackUserId } = await matchCaller(fromNumber);

  // Plivo may ask twice (a retry): the same call is written once.
  const call = await Call.findOneAndUpdate(
    { plivoCallUuid: String(params.CallUUID) },
    {
      $setOnInsert: {
        direction: 'inbound',
        fromNumber: fromNumber ?? `+${String(params.From ?? '').replace(/\D/g, '')}`,
        toNumber: ourNumber(),
        status: 'ringing',
        startedAt: new Date(),
        userId: userId ?? undefined,
        fallbackUserId: fallbackUserId ?? undefined,
        contactId: contact?._id,
        accountId: contact?.accountId,
        opportunityId: lead?._id,
      },
    },
    { upsert: true, returnDocument: 'after' },
  ).lean();
  announce();
  if (!phone) return speakXml(NOBODY_AVAILABLE);
  return dialXml({
    number: phone,
    // With someone to try next, the first phone rings a shorter time.
    ...(call.fallbackUserId ? { timeoutSec: FIRST_RING_SEC } : {}),
    resultUrl: plivoUrl('dial-result', { call: call._id, step: 1 }),
    ...(await recordingOptions(call._id)),
  });
}

/** Inbound, first ring over and nobody talked: the phone of the next person, or null. */
async function nextPhone(call, step, params) {
  if (call?.direction !== 'inbound' || String(step) !== '1') return null;
  if (params.DialStatus === 'completed' || !call.fallbackUserId) return null;
  return phoneOfUser(call.fallbackUserId);
}

/**
 * A rung phone has ended. For an inbound call that the first person did not pick up, Plivo is
 * told to ring the next person; in every other case there is nothing more to do.
 * (Asking twice gives the same answer: nothing is written here.)
 */
export async function answerDialResult(callId, step, params) {
  const call = mongooseId(callId) ? await Call.findById(callId).lean() : null;
  const phone = await nextPhone(call, step, params);
  if (!phone) return emptyXml();
  return dialXml({
    number: phone,
    timeoutSec: SECOND_RING_SEC,
    resultUrl: plivoUrl('dial-result', { call: call._id, step: 2 }),
    ...(await recordingOptions(call._id)),
  });
}

/** The "this call may be recorded" announcement. */
export async function answerConsent() {
  return speakXml((await readSettings()).consentText);
}

// Plivo reports a call's charge in US dollars (callbacks and API), while its console for an
// Indian account shows rupees. Its two price lists differ by this fixed factor (0.00475 dollars
// and 0.38 rupees a minute), so this is not a currency rate that moves.
const PLIVO_USD_TO_INR = 80;

// ── What the background job does with Plivo's events ────────────────────────────────────────

const seconds = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
// Raised when the way a finished call is read from Plivo's record changes: every call of the
// last two weeks is then read once more.
const SETTLE_VERSION = 2;
const clock = (total) => `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
const RESULT_WORDS = {
  missed: 'missed',
  busy: 'busy',
  no_answer: 'no answer',
  failed: 'did not connect',
};

/** Work out how a call ended from what Plivo said about its two sides. */
function resultOf(call) {
  const dial = call.plivo?.dial;
  const hangup = call.plivo?.hangup;
  // Plivo's own record of each side, read a little after the hang-up (settleCall): the exact
  // length and charge. Until then the callbacks have to do.
  const { aLeg, bLeg } = call.plivo ?? {};
  // "completed" on the dialled side means: the other person picked up. (Plivo does not send
  // the length of that side with this callback, so the length must not decide it.)
  const talked = dial?.DialStatus === 'completed';
  const cost =
    aLeg || bLeg
      ? seconds(aLeg?.cost) + seconds(bLeg?.cost)
      : seconds(hangup?.TotalCost) + seconds(dial?.DialBLegTotalCost);
  const length =
    seconds(bLeg?.durationSec) ||
    seconds(dial?.DialBLegDuration) ||
    // The whole call from Plivo's hang-up callback: a little long (it includes the ringing).
    // Not BillDuration: that is rounded up to Plivo's 30-second billing steps.
    seconds(hangup?.Duration) ||
    seconds(hangup?.BillDuration);
  const base = {
    durationSec: talked ? length : 0,
    cost: cost || undefined,
  };
  if (talked) return { ...base, status: 'completed', hangupCause: hangup?.HangupCause };
  if (call.direction === 'inbound')
    return { ...base, status: 'missed', hangupCause: dial?.DialStatus };
  // Outbound: the agent's own phone has to pick up first.
  if (!dial) return { ...base, status: 'no_answer', hangupCause: 'agent_did_not_pick_up' };
  const status = { busy: 'busy', 'no-answer': 'no_answer', timeout: 'no_answer' }[dial.DialStatus];
  return { ...base, status: status ?? 'failed', hangupCause: dial.DialStatus };
}

/** The timeline entry of a finished call. `who`: the name of the other side, or their number. */
function timelineEntry(call, who) {
  const how =
    call.status === 'completed' ? clock(call.durationSec ?? 0) : RESULT_WORDS[call.status];
  return {
    type: 'CALL',
    subtype: 'call_ended',
    direction: call.direction,
    contactId: call.contactId ?? undefined,
    accountId: call.accountId ?? undefined,
    opportunityId: call.opportunityId ?? undefined,
    userId: call.userId,
    occurredAt: call.startedAt ?? call.endedAt,
    title: `${call.direction === 'outbound' ? 'Call to' : 'Call from'} ${who} · ${how}`,
    status: call.status,
    refCollection: 'calls',
    refId: call._id,
    metadata: { callId: String(call._id), durationSec: call.durationSec ?? 0 },
  };
}

/** Everything that happens once, when a call is over. */
async function finishCall(callId) {
  const call = await Call.findById(callId).lean();
  if (!call) return;
  const result = resultOf(call);
  const endedAt = call.endedAt ?? new Date();
  await Call.updateOne({ _id: call._id }, { $set: { ...result, endedAt } });

  const contact = call.contactId
    ? await Contact.findById(call.contactId).select('name').lean()
    : null;
  const who = contact?.name ?? (call.direction === 'outbound' ? call.toNumber : call.fromNumber);

  // On the timeline of the contact, the lead and the company. (A call from a number nobody
  // knows belongs to no record: it shows in the list of calls, and can be put on a person there.)
  if (call.contactId || call.accountId || call.opportunityId) {
    await recordActivity(timelineEntry({ ...call, ...result, endedAt }, who));
  }

  if (call.direction === 'inbound' && result.status === 'missed' && call.userId) {
    await notify({
      userId: call.userId,
      type: 'call_missed',
      title: `Missed call from ${who}`,
      body: contact ? call.fromNumber : 'A number that is not in the CRM',
      link: call.opportunityId ? `/pipeline/${call.opportunityId}` : `/calls/${call._id}`,
      dedupeKey: `call-missed:${call._id}`,
    });
    // The call-back task. One per call: a second run finds it there already.
    await createTask(
      systemActor(),
      {
        title: `Call back ${who}`.slice(0, 200),
        type: 'call',
        priority: 'high',
        dueAt: new Date(Date.now() + CALL_BACK_DUE_MS),
        assigneeId: String(call.userId),
        ...(call.opportunityId
          ? { opportunityId: String(call.opportunityId) }
          : call.accountId
            ? { accountId: String(call.accountId) }
            : {}),
        ...(contact && !call.opportunityId ? { contactId: String(call.contactId) } : {}),
      },
      { origin: { source: 'system', sourceRef: { from: 'calls', id: call._id } } },
    ).catch((error) => {
      if (error?.code !== 11000) throw error;
    });
  }
}

/**
 * Read Plivo's own record of a finished call (both sides) and correct the call with it: the
 * exact length and what Plivo charged, as its console shows them. A background job calls this
 * a minute after the hang-up, and again later for calls whose record was not ready.
 * @returns {Promise<'settled' | 'not ready' | 'skipped'>}
 */
export async function settleCall(callId) {
  const call = await Call.findById(callId).lean();
  if (!call?.endedAt || call.plivo?.settleVersion === SETTLE_VERSION) return 'skipped';
  const sides = [call.plivoCallUuid, call.plivo?.dial?.DialBLegUUID].map((uuid) =>
    uuid ? getCallRecord(String(uuid)) : null,
  );
  const [aLeg, bLeg] = await Promise.all(sides);
  if (!aLeg && !bLeg) return 'not ready';
  const result = resultOf({ ...call, plivo: { ...call.plivo, aLeg, bLeg } });
  await Call.updateOne(
    { _id: call._id },
    {
      $set: {
        ...result,
        'plivo.aLeg': aLeg,
        'plivo.bLeg': bLeg,
        'plivo.settledAt': new Date(),
        'plivo.settleVersion': SETTLE_VERSION,
      },
    },
  );
  // The line on the timeline says the length: bring it in step.
  if (call.contactId || call.accountId || call.opportunityId) {
    const contact = call.contactId
      ? await Contact.findById(call.contactId).select('name').lean()
      : null;
    const who = contact?.name ?? (call.direction === 'outbound' ? call.toNumber : call.fromNumber);
    const entry = timelineEntry({ ...call, ...result }, who);
    await relinkActivity(
      { refCollection: 'calls', refId: call._id, subtype: 'call_ended' },
      {
        accountId: call.accountId,
        contactId: call.contactId,
        opportunityId: call.opportunityId,
        title: entry.title,
        status: entry.status,
      },
    );
  }
  announce();
  return 'settled';
}

/**
 * Every ten minutes: settle the calls of the last two weeks that are not settled yet (the
 * queue was away, or Plivo's record was not ready a minute after the hang-up).
 * @param {Date} [now]  Only tests pass it
 */
export async function settleWaitingCalls(now = new Date()) {
  const waiting = await Call.find({
    endedAt: {
      $gt: new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000),
      $lt: new Date(now.getTime() - 60 * 1000),
    },
    plivoCallUuid: { $ne: null },
    'plivo.settleVersion': { $ne: SETTLE_VERSION },
  })
    .select('_id')
    .sort({ endedAt: -1 })
    .limit(25)
    .lean();
  let settled = 0;
  for (const call of waiting) {
    try {
      if ((await settleCall(call._id)) === 'settled') settled += 1;
    } catch (error) {
      logger.warn({ err: error, callId: String(call._id) }, 'A call could not be settled');
    }
  }
  return { looked: waiting.length, settled };
}

/** Keep a finished recording in our own storage. */
async function storeRecording(call, params) {
  const url = params.RecordUrl ?? params.RecordFile;
  if (!url) return;
  if (!isStorageConfigured()) {
    logger.warn({ callId: String(call._id) }, 'Recording not kept: file storage is not set up');
    return;
  }
  const { body, contentType } = await downloadRecording(url);
  const recordingUrl = await uploadObject({
    key: `recordings/${call._id}.mp3`,
    body,
    contentType,
  });
  await Call.updateOne({ _id: call._id }, { $set: { recordingUrl } });
}

/**
 * The processor of Plivo's webhook events.
 * @param {{ payload: { kind: string, call?: string, params: object } }} event  A stored event
 */
async function processPlivoEvent(event) {
  const { kind, call: callId, step, params = {} } = event.payload ?? {};
  const call = mongooseId(callId)
    ? await Call.findById(callId).lean()
    : params.CallUUID
      ? await Call.findOne({ plivoCallUuid: String(params.CallUUID) }).lean()
      : null;
  if (!call) return;

  if (kind === 'connect') {
    // Click-to-call: the agent picked up; the customer is being dialled now.
    await Call.updateOne(
      { _id: call._id, endedAt: null },
      { $set: { status: 'in_progress', answeredAt: new Date() } },
    );
  } else if (kind === 'dial-result') {
    if (await nextPhone(call, step, params)) {
      // The first person did not pick up and the next one is being rung: not the result yet.
      await Call.updateOne({ _id: call._id }, { $set: { 'plivo.firstDial': params } });
      announce();
      return;
    }
    const talked = params.DialStatus === 'completed';
    const answeredBy = String(step) === '2' ? call.fallbackUserId : call.userId;
    await Call.updateOne(
      { _id: call._id },
      {
        $set: {
          'plivo.dial': params,
          ...(call.direction === 'inbound' && talked && answeredBy
            ? { answeredByUserId: answeredBy }
            : {}),
        },
      },
    );
    // Usually the hang-up comes after this; when it came first, the result is worked out again.
    if (call.endedAt) await finishCall(call._id);
  } else if (kind === 'hangup') {
    await Call.updateOne({ _id: call._id }, { $set: { 'plivo.hangup': params } });
    await finishCall(call._id);
    // Plivo's books are ready a little later: the exact length and charge are read then.
    // (The automated tests call settleCall themselves; without a queue the sweep does it.)
    if (env.NODE_ENV !== 'test') {
      await enqueue(
        'integrations',
        JOB_NAMES.callSettle,
        { callId: String(call._id) },
        { delayMs: 60_000, jobId: `call-settle-${call._id}` },
      ).catch(() => {});
    }
  } else if (kind === 'recording') {
    await storeRecording(call, params);
  }
  announce();
}
registerWebhookProcessor('plivo', processPlivoEvent);
