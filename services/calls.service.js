import { SOCKET_EVENTS } from '../constants/socketEvents.js';
import { logger } from '../infra/logger.js';
import { emitToAll } from '../infra/realtime.js';
import { isStorageConfigured, toReadableUrl, uploadObject } from '../infra/storage.js';
import {
  dialXml,
  downloadRecording,
  emptyXml,
  isPlivoConfigured,
  missingPlivoSettings,
  ourNumber,
  plivoUrl,
  speakXml,
  startCall as placeCall,
} from '../integrations/plivo/client.js';
import { writeAudit } from '../lib/audit.js';
import { can } from '../lib/can.js';
import { badRequest, conflict, createAppError, forbidden, notFound } from '../lib/errors.js';
import { normalizePhone } from '../lib/phone.js';
import { runListQuery } from '../lib/queryBuilder.js';
import { systemActor } from '../lib/systemActor.js';
import { Account } from '../models/account.model.js';
import { Call } from '../models/call.model.js';
import { Contact } from '../models/contact.model.js';
import { Opportunity } from '../models/opportunity.model.js';
import { Settings } from '../models/settings.model.js';
import { User } from '../models/user.model.js';
import { loadAccountForAction } from './accounts.service.js';
import { recordActivity } from './activities.service.js';
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
const DEFAULT_CONSENT = 'This call may be recorded for quality and training.';
const NOBODY_AVAILABLE =
  'Thank you for calling. Nobody is available right now. We will call you back shortly.';
const announce = () => emitToAll(SOCKET_EVENTS.callsChanged);

async function readSettings() {
  const settings = await Settings.findOne({ key: 'app' }).select('calls').lean();
  return {
    recordingEnabled: settings?.calls?.recordingEnabled ?? false,
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
  const [users, contacts] = await Promise.all([
    User.find({ _id: { $in: ids('userId') } })
      .select('name')
      .lean(),
    Contact.find({ _id: { $in: ids('contactId') } })
      .select('name')
      .lean(),
  ]);
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
      outcome: call.outcome ?? null,
      user: named(users, call.userId),
      contact: named(contacts, call.contactId),
      opportunityId: call.opportunityId ? String(call.opportunityId) : null,
      hasRecording: Boolean(call.recordingUrl),
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
    throw badRequest('Say which lead, company or contact the calls are of.');
  }
  const { rows, pagination } = await runListQuery(Call, {
    filter,
    sort: { startedAt: -1, _id: -1 },
    page: query.page,
    pageSize: query.pageSize,
    select: '-plivo',
  });
  return { items: await toViews(rows, actor), pagination };
}

/** One call for an action, by the "calls" permission; anything else is "not found". */
async function loadCallForAction(actor, callId, action) {
  const call = await Call.findById(callId).lean();
  const record = { feature: FEATURE, record: call, ...OWNERSHIP };
  if (!call || !can(actor, 'view', record)) throw notFound('Call not found');
  if (action !== 'view' && !can(actor, action, record)) {
    throw forbidden('You do not have permission to do this with this call.');
  }
  return call;
}

/** Say what came of a call. @param {{ outcome: string | null }} changes  Validated */
export async function updateCall(actor, callId, { outcome }, context = {}) {
  const call = await loadCallForAction(actor, callId, 'edit');
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
  await Call.updateOne({ _id: callId }, { $set: { recordingConsentPlayed: true } });
  return {
    recordingUrl: plivoUrl('recording', { call: callId }),
    // The announcement is said to the side that is being dialled, before the two are joined.
    consentUrl: plivoUrl('consent'),
  };
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
    if (phone) return { contact, lead, userId, phone };
  }
  return { contact, lead, userId: candidates.find(Boolean) ?? null, phone: null };
}

/**
 * Inbound: a customer called our number. The call is written down, and Plivo is told whose
 * phone to ring (or to say that nobody is available).
 * @param {{ CallUUID?: string, From?: string, To?: string }} params  Plivo's form fields
 */
export async function answerInbound(params) {
  if (!params.CallUUID) return speakXml(NOBODY_AVAILABLE);
  const fromNumber = normalizePhone(`+${String(params.From ?? '').replace(/\D/g, '')}`);
  const { contact, lead, userId, phone } = await matchCaller(fromNumber);

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
    resultUrl: plivoUrl('dial-result', { call: call._id }),
    ...(await recordingOptions(call._id)),
  });
}

/** The "this call may be recorded" announcement. */
export async function answerConsent() {
  return speakXml((await readSettings()).consentText);
}

// ── What the background job does with Plivo's events ────────────────────────────────────────

const seconds = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
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
  const talked = dial?.DialStatus === 'completed' && seconds(dial.DialBLegDuration) > 0;
  const cost = seconds(hangup?.TotalCost) + seconds(dial?.DialBLegTotalCost);
  const base = {
    durationSec: talked ? seconds(dial.DialBLegDuration) : 0,
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
  const how =
    result.status === 'completed' ? clock(result.durationSec) : RESULT_WORDS[result.status];

  // On the timeline of the contact, the lead and the company. (A call from a number nobody
  // knows belongs to no record: it shows only as a missed call to the person it was for.)
  if (call.contactId || call.accountId || call.opportunityId) {
    await recordActivity({
      type: 'CALL',
      subtype: 'call_ended',
      direction: call.direction,
      contactId: call.contactId,
      accountId: call.accountId,
      opportunityId: call.opportunityId,
      userId: call.userId,
      occurredAt: call.startedAt ?? endedAt,
      title: `${call.direction === 'outbound' ? 'Call to' : 'Call from'} ${who} · ${how}`,
      status: result.status,
      refCollection: 'calls',
      refId: call._id,
      metadata: { callId: String(call._id), durationSec: result.durationSec },
    });
  }

  if (call.direction === 'inbound' && result.status === 'missed' && call.userId) {
    await notify({
      userId: call.userId,
      type: 'call_missed',
      title: `Missed call from ${who}`,
      body: contact ? call.fromNumber : 'A number that is not in the CRM',
      link: call.opportunityId ? `/pipeline/${call.opportunityId}` : '/activities',
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
  const { kind, call: callId, params = {} } = event.payload ?? {};
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
    await Call.updateOne({ _id: call._id }, { $set: { 'plivo.dial': params } });
    // Usually the hang-up comes after this; when it came first, the result is worked out again.
    if (call.endedAt) await finishCall(call._id);
  } else if (kind === 'hangup') {
    await Call.updateOne({ _id: call._id }, { $set: { 'plivo.hangup': params } });
    await finishCall(call._id);
  } else if (kind === 'recording') {
    await storeRecording(call, params);
  }
  announce();
}
registerWebhookProcessor('plivo', processPlivoEvent);
