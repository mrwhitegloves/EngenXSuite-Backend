import { SOCKET_EVENTS } from '../constants/socketEvents.js';
import { insertEvent, patchEvent, removeEvent } from '../integrations/google/calendar.js';
import { logger } from '../infra/logger.js';
import { emitToAll } from '../infra/realtime.js';
import { writeAudit } from '../lib/audit.js';
import { can } from '../lib/can.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { scopeFilter } from '../lib/scopeFilter.js';
import { Account } from '../models/account.model.js';
import { Contact } from '../models/contact.model.js';
import { MEETING_MODES, Meeting } from '../models/meeting.model.js';
import { MeetingSummary } from '../models/meetingSummary.model.js';
import { Opportunity } from '../models/opportunity.model.js';
import { User } from '../models/user.model.js';
import { UserGoogleConnection } from '../models/userGoogleConnection.model.js';
import { loadAccountForAction } from './accounts.service.js';
import { recordActivity } from './activities.service.js';
import { getGoogleAccessToken } from './googleConnection.service.js';
import { notify } from './notifications.service.js';
import { loadLeadForAction } from './opportunities.service.js';

// Meetings and plant visits (Master Prompt Section 21).
//
// Who sees a meeting:
//   - its organizer and the colleagues invited to it, always
//   - beyond that, the "meetings" permission scope: a manager their team's, the CEO all
//   - on the page of a lead or a company: everyone who may see that record sees its meetings
// A meeting about a lead is reached only by someone who may see that lead (decision 0008).
//
// A meeting is always in the calendar of its organizer: the person who planned it. When their
// Google Calendar is connected, the meeting is put there too (with a Meet link for an online
// meeting) and Google sends the invitations. Without a connection it lives in the CRM only.
// Changes made in Google Calendar come back through services/calendarSync.service.js.

const FEATURE = 'meetings';
const OWNERSHIP = { ownerField: 'organizerId' };
const MAX_ROWS = 500;
export const REMIND_BEFORE_MS = 30 * 60 * 1000;

const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const fieldProblem = (field, message) => badRequest(message, [{ field, message }]);
const announce = () => emitToAll(SOCKET_EVENTS.meetingsChanged);
const isInvited = (actor, meeting) =>
  sameId(meeting.organizerId, actor._id) ||
  meeting.internalAttendeeIds.some((id) => sameId(id, actor._id));
const timeOf = (date) =>
  new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(date);
const linkOf = (meeting) => `/calendar?meeting=${meeting._id}`;

/** Looking: the invited and the permission scope. Changing: the organizer and the scope. */
function allowed(actor, action, meeting) {
  const hasFeature = can(actor, action, { feature: FEATURE });
  if (action === 'view' && hasFeature && isInvited(actor, meeting)) return true;
  if (hasFeature && sameId(meeting.organizerId, actor._id)) return true;
  return can(actor, action, { feature: FEATURE, record: meeting, ...OWNERSHIP });
}

/** True when the actor may see the lead or company the meeting is about. */
async function seesLinkedRecord(actor, meeting) {
  try {
    if (meeting.opportunityId) await loadLeadForAction(actor, meeting.opportunityId, 'view');
    else if (meeting.accountId) await loadAccountForAction(actor, meeting.accountId, 'view');
    else return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Load one meeting for an action. Not visible: "not found". Visible but not allowed:
 * "forbidden". A meeting about a lead the actor may not see is "not found".
 */
export async function loadMeetingForAction(actor, meetingId, action) {
  const meeting = await Meeting.findById(meetingId).lean();
  if (!meeting) throw notFound('Meeting not found');
  const viaRecord = await seesLinkedRecord(actor, meeting);
  if (meeting.opportunityId && !viaRecord) throw notFound('Meeting not found');
  if (!viaRecord && !allowed(actor, 'view', meeting)) throw notFound('Meeting not found');
  if (action !== 'view' && !allowed(actor, action, meeting)) {
    throw forbidden('Only the organizer of this meeting, or their manager, can change it.');
  }
  return meeting;
}

async function loadLookups(meetings) {
  const ids = (pick) => [...new Set(meetings.flatMap(pick).filter(Boolean).map(String))];
  const byId = (items) => new Map(items.map((item) => [String(item._id), item]));
  const [users, accounts, leads] = await Promise.all([
    User.find({
      _id: { $in: ids((meeting) => [meeting.organizerId, ...meeting.internalAttendeeIds]) },
    })
      .select('name')
      .lean(),
    Account.find({ _id: { $in: ids((meeting) => [meeting.accountId]) } })
      .select('name')
      .lean(),
    Opportunity.find({ _id: { $in: ids((meeting) => [meeting.opportunityId]) } })
      .select('name')
      .lean(),
  ]);
  return { users: byId(users), accounts: byId(accounts), leads: byId(leads) };
}

function toView(meeting, lookups, actor) {
  const named = (map, id) => {
    const item = id && map.get(String(id));
    return item ? { id: String(item._id), name: item.name } : null;
  };
  const canEdit = allowed(actor, 'edit', meeting);
  return {
    id: String(meeting._id),
    title: meeting.title,
    typeId: meeting.typeId ? String(meeting.typeId) : null,
    mode: meeting.mode,
    status: meeting.status,
    startAt: meeting.startAt,
    endAt: meeting.endAt,
    location: meeting.location ?? null,
    agenda: meeting.agenda ?? null,
    notes: meeting.notes ?? null,
    meetLink: meeting.meetLink ?? null,
    organizer: named(lookups.users, meeting.organizerId),
    colleagues: meeting.internalAttendeeIds.map((id) => named(lookups.users, id)).filter(Boolean),
    attendees: meeting.attendees.map((person) => ({
      contactId: person.contactId ? String(person.contactId) : null,
      name: person.name ?? null,
      email: person.email ?? null,
      response: person.response,
    })),
    account: named(lookups.accounts, meeting.accountId),
    lead: named(lookups.leads, meeting.opportunityId),
    guestOptions: {
      canInviteOthers: meeting.guestOptions?.canInviteOthers ?? true,
      canModify: meeting.guestOptions?.canModify ?? false,
      canSeeGuests: meeting.guestOptions?.canSeeGuests ?? true,
    },
    bookedVia: meeting.bookedVia,
    isInGoogleCalendar: Boolean(meeting.googleEventId),
    googleSyncError: meeting.googleSyncError ?? null,
    permissions: { canEdit, canDelete: allowed(actor, 'delete', meeting) },
  };
}

async function viewOf(meeting, actor) {
  return toView(meeting, await loadLookups([meeting]), actor);
}

/**
 * Meetings, for the calendar (a span of days, inside the actor's scope) or for one lead or
 * company (everyone who may see that record sees its meetings; newest first).
 * @param {{ from?: Date, to?: Date, mine?: boolean, opportunityId?: string,
 *           accountId?: string }} query  Validated
 */
export async function listMeetings(actor, query) {
  const parts = [];
  let sort = { startAt: 1, _id: 1 };
  if (query.opportunityId) {
    const lead = await loadLeadForAction(actor, query.opportunityId, 'view');
    parts.push({ opportunityId: lead._id });
    sort = { startAt: -1, _id: -1 };
  } else if (query.accountId) {
    const account = await loadAccountForAction(actor, query.accountId, 'view');
    parts.push({ accountId: account._id });
    sort = { startAt: -1, _id: -1 };
    // Meetings of this company's leads only when the person may see those leads.
    const leadScope = scopeFilter(actor, 'opportunities');
    if (Object.keys(leadScope).length > 0) {
      const visible = await Opportunity.distinct('_id', {
        $and: [leadScope, { accountId: account._id }],
      });
      parts.push({ $or: [{ opportunityId: null }, { opportunityId: { $in: visible } }] });
    }
  } else {
    const own = { $or: [{ organizerId: actor._id }, { internalAttendeeIds: actor._id }] };
    const byPermission = scopeFilter(actor, FEATURE, OWNERSHIP);
    if (query.mine) parts.push(own);
    else if (Object.keys(byPermission).length > 0) parts.push({ $or: [byPermission, ...own.$or] });
  }
  // Everything that touches the span: it starts before the span ends and ends after it starts.
  if (query.from) parts.push({ endAt: { $gt: query.from } });
  if (query.to) parts.push({ startAt: { $lt: query.to } });

  const rows = await Meeting.find(parts.length ? { $and: parts } : {})
    .sort(sort)
    .limit(MAX_ROWS)
    .lean();
  const lookups = await loadLookups(rows);
  return rows.map((meeting) => toView(meeting, lookups, actor));
}

export async function getMeeting(actor, meetingId) {
  return viewOf(await loadMeetingForAction(actor, meetingId, 'view'), actor);
}

/** What the meeting form offers: the kinds of meeting, colleagues, and my calendar's state. */
export async function getMeetingFormOptions(actor) {
  const [users, isConnected] = await Promise.all([
    User.find({ status: 'active', _id: { $ne: actor._id } })
      .select('name')
      .sort({ name: 1 })
      .lean(),
    UserGoogleConnection.exists({ userId: actor._id, status: 'connected' }),
  ]);
  return {
    modes: MEETING_MODES,
    colleagues: users.map((user) => ({ id: String(user._id), name: user.name })),
    isCalendarConnected: Boolean(isConnected),
  };
}

/** What a meeting is about: a lead (with its company) or a company, and the people of it. */
async function resolveLinks(actor, data) {
  const links = {};
  if (data.opportunityId) {
    const lead = await loadLeadForAction(actor, data.opportunityId, 'view');
    links.opportunityId = lead._id;
    links.accountId = lead.accountId;
  } else if (data.accountId) {
    links.accountId = (await loadAccountForAction(actor, data.accountId, 'view'))._id;
  }
  return { ...links, ...(await resolvePeople(actor, links.accountId, data)) };
}

/**
 * The guests from outside (people of the meeting's company, and anyone else by email) and the
 * colleagues who join. `before`: the meeting as it is, when it is being changed: a kind of
 * guest that the change does not name stays as it was, and an answer already given is kept.
 */
async function resolvePeople(actor, accountId, data, before) {
  const links = {};
  if (data.contactIds || data.extraGuests) {
    const was = before?.attendees ?? [];
    let people = was.filter((person) => person.contactId);
    if (data.contactIds) {
      const contacts = await Contact.find({ _id: { $in: data.contactIds }, deletedAt: null })
        .select('name email accountId')
        .lean();
      const isOfCompany = (contact) => accountId && sameId(contact.accountId, accountId);
      if (contacts.length !== new Set(data.contactIds).size || !contacts.every(isOfCompany)) {
        throw fieldProblem('contactIds', 'Choose people of this company');
      }
      people = contacts.map((contact) => ({
        contactId: contact._id,
        name: contact.name,
        email: contact.email || undefined,
      }));
    }
    const others = data.extraGuests ?? was.filter((person) => !person.contactId);
    const taken = new Set(people.map((person) => person.email).filter(Boolean));
    const answers = new Map(was.map((person) => [person.email, person.response]));
    links.attendees = [
      ...people,
      // The same address is one guest, and a person of the company is not a guest twice.
      ...others
        .filter((guest) => !taken.has(guest.email) && taken.add(guest.email))
        .map((guest) => ({ email: guest.email, name: guest.name || undefined })),
    ].map((person) => ({ ...person, response: answers.get(person.email) ?? 'needsAction' }));
  }
  if (data.internalAttendeeIds) {
    const ids = [...new Set(data.internalAttendeeIds)].filter((id) => !sameId(id, actor._id));
    if ((await User.countDocuments({ _id: { $in: ids }, status: 'active' })) !== ids.length) {
      throw fieldProblem('internalAttendeeIds', 'Choose active users');
    }
    links.internalAttendeeIds = ids;
  }
  return links;
}

/**
 * Bring the organizer's Google Calendar in step with a meeting. A failure never stops the CRM:
 * the meeting is kept, and says that Google Calendar could not be reached.
 * @param {'save' | 'remove'} change
 */
async function pushToGoogle(meeting, change, tellGuests = true) {
  const isConnected = await UserGoogleConnection.exists({
    userId: meeting.organizerId,
    status: 'connected',
  });
  if (!isConnected) return meeting;
  const update = { $unset: { googleSyncError: 1 } };
  try {
    const token = await getGoogleAccessToken(meeting.organizerId);
    const colleagues = await User.find({ _id: { $in: meeting.internalAttendeeIds } })
      .select('name email')
      .lean();
    const event = {
      title: meeting.title,
      agenda: meeting.agenda,
      location: meeting.location,
      startAt: meeting.startAt,
      endAt: meeting.endAt,
      guestOptions: meeting.guestOptions,
      guests: [...meeting.attendees, ...colleagues]
        .filter((person) => person.email)
        .map((person) => ({ email: person.email, name: person.name })),
    };
    if (change === 'remove') {
      if (meeting.googleEventId) await removeEvent(token, meeting.googleEventId, { tellGuests });
    } else if (meeting.googleEventId) {
      // A meeting that became an online one gets its Meet link now.
      const changed = await patchEvent(token, meeting.googleEventId, event, {
        withMeet: meeting.mode === 'online' && !meeting.meetLink,
        tellGuests,
      });
      if (changed.meetLink && changed.meetLink !== meeting.meetLink) {
        update.$set = { meetLink: changed.meetLink };
      }
    } else {
      const created = await insertEvent(token, event, {
        withMeet: meeting.mode === 'online',
        tellGuests,
      });
      update.$set = { googleEventId: created.id };
      if (created.meetLink) update.$set.meetLink = created.meetLink;
    }
  } catch (error) {
    logger.warn({ err: error, meetingId: String(meeting._id) }, 'Google Calendar was not updated');
    delete update.$unset;
    update.$set = { googleSyncError: String(error?.message ?? 'Unknown error').slice(0, 300) };
  }
  return Meeting.findByIdAndUpdate(meeting._id, update, { returnDocument: 'after' }).lean();
}

/** The timeline entry of a meeting event, when the meeting is about a company or a lead. */
async function onTimeline(meeting, userId, subtype, title, extra = {}) {
  if (!meeting.accountId && !meeting.opportunityId) return;
  await recordActivity({
    type: 'MEETING',
    direction: 'internal',
    subtype,
    title,
    accountId: meeting.accountId,
    opportunityId: meeting.opportunityId,
    contactId: meeting.attendees[0]?.contactId,
    userId,
    refCollection: 'meetings',
    refId: meeting._id,
    ...extra,
  });
}

/**
 * Plan a meeting. The actor is its organizer.
 * @param {{ title: string, mode: string, startAt: Date, endAt: Date, location?: string,
 *           agenda?: string, opportunityId?: string, accountId?: string, contactIds?: string[],
 *           internalAttendeeIds?: string[], tellGuests?: boolean }} data  Validated
 */
export async function createMeeting(actor, data, context = {}) {
  const links = await resolveLinks(actor, data);
  const saved = await Meeting.create({
    title: data.title,
    typeId: data.typeId,
    mode: data.mode,
    // Planned here, or booked by a customer on a booking page.
    bookedVia: context.bookedVia ?? 'crm',
    startAt: data.startAt,
    endAt: data.endAt,
    location: data.location,
    agenda: data.agenda,
    guestOptions: data.guestOptions,
    ...links,
    organizerId: actor._id,
    createdBy: actor._id,
  });
  const meeting = await pushToGoogle(saved.toObject(), 'save', data.tellGuests ?? true);

  await onTimeline(meeting, actor._id, 'meeting_planned', `Meeting planned: ${meeting.title}`, {
    content: `${timeOf(meeting.startAt)}${meeting.location ? `, ${meeting.location}` : ''}`,
  });
  for (const userId of meeting.internalAttendeeIds) {
    await notify({
      userId,
      actorId: actor._id,
      type: 'meeting_invite',
      title: `${actor.name} invited you to a meeting`,
      body: `${meeting.title}, ${timeOf(meeting.startAt)}`,
      link: linkOf(meeting),
    });
  }
  await writeAudit({
    actor,
    action: 'meeting.created',
    entityType: 'meetings',
    entityId: meeting._id,
    newValue: { title: meeting.title, startAt: meeting.startAt, mode: meeting.mode },
    requestId: context.requestId,
  });
  announce();
  return viewOf(meeting, actor);
}

/**
 * Change a meeting. A meeting that is still planned can be changed in every part (a new time
 * moves it in Google Calendar too); afterwards only its notes.
 * @param {{ title?: string, mode?: string, startAt?: Date, endAt?: Date, location?: string,
 *           agenda?: string, notes?: string, contactIds?: string[],
 *           internalAttendeeIds?: string[], tellGuests?: boolean }} changes  Validated
 */
export async function updateMeeting(actor, meetingId, changes, context = {}) {
  const before = await loadMeetingForAction(actor, meetingId, 'edit');
  const { notes, tellGuests = true, ...plan } = changes;
  const hasPlanChange = Object.values(plan).some((value) => value !== undefined);
  if (hasPlanChange && before.status !== 'scheduled') {
    throw conflict('This meeting is over or cancelled: only its notes can be changed.');
  }
  const set = {};
  for (const field of ['title', 'typeId', 'mode', 'startAt', 'endAt', 'location', 'agenda']) {
    if (plan[field] !== undefined) set[field] = plan[field];
  }
  if (notes !== undefined) set.notes = notes;
  const startAt = set.startAt ?? before.startAt;
  const endAt = set.endAt ?? before.endAt;
  if (endAt <= startAt) throw fieldProblem('endAt', 'The end must be after the start');
  if (plan.guestOptions) {
    for (const [key, value] of Object.entries(plan.guestOptions))
      set[`guestOptions.${key}`] = value;
  }
  Object.assign(set, await resolvePeople(actor, before.accountId, plan, before));
  const isMoved = +startAt !== +before.startAt;
  const saved = await Meeting.findByIdAndUpdate(
    before._id,
    { $set: set, ...(isMoved ? { $unset: { reminderSentAt: 1 } } : {}) },
    { returnDocument: 'after' },
  ).lean();
  const meeting = hasPlanChange ? await pushToGoogle(saved, 'save', tellGuests) : saved;

  if (isMoved) {
    await onTimeline(meeting, actor._id, `meeting_moved_${+startAt}`, 'Meeting moved', {
      content: `${meeting.title}: from ${timeOf(before.startAt)} to ${timeOf(startAt)}`,
    });
  }
  await writeAudit({
    actor,
    action: 'meeting.updated',
    entityType: 'meetings',
    entityId: meeting._id,
    oldValue: { title: before.title, startAt: before.startAt },
    newValue: { title: meeting.title, startAt: meeting.startAt, fields: Object.keys(set) },
    requestId: context.requestId,
  });
  announce();
  return viewOf(meeting, actor);
}

const STATUS_WORDS = {
  completed: ['meeting_held', 'Meeting held'],
  no_show: ['meeting_no_show', 'Meeting: the customer did not come'],
  cancelled: ['meeting_cancelled', 'Meeting cancelled'],
};

/**
 * Close a planned meeting: it was held (with notes of what was said), the customer did not
 * come, or it is cancelled (it then leaves Google Calendar and the guests are told).
 * @param {{ status: 'completed' | 'no_show' | 'cancelled', notes?: string,
 *           tellGuests?: boolean }} change  Validated
 */
export async function closeMeeting(actor, meetingId, change, context = {}) {
  const before = await loadMeetingForAction(actor, meetingId, 'edit');
  if (before.status !== 'scheduled') throw conflict('This meeting is closed already.');
  const saved = await Meeting.findOneAndUpdate(
    { _id: before._id, status: 'scheduled' },
    { $set: { status: change.status, ...(change.notes ? { notes: change.notes } : {}) } },
    { returnDocument: 'after' },
  ).lean();
  if (!saved) throw conflict('This meeting is closed already.');
  const meeting =
    change.status === 'cancelled'
      ? await pushToGoogle(saved, 'remove', change.tellGuests ?? true)
      : saved;

  const [subtype, words] = STATUS_WORDS[change.status];
  await onTimeline(meeting, actor._id, subtype, `${words}: ${meeting.title}`, {
    content: change.notes,
    // A meeting that was held stands on the timeline at the time it took place.
    ...(change.status === 'completed' && meeting.startAt < new Date()
      ? { occurredAt: meeting.startAt, direction: 'outbound' }
      : {}),
  });
  await writeAudit({
    actor,
    action: `meeting.${change.status}`,
    entityType: 'meetings',
    entityId: meeting._id,
    oldValue: { status: before.status },
    newValue: { status: meeting.status },
    requestId: context.requestId,
  });
  announce();
  return viewOf(meeting, actor);
}

/**
 * Delete a meeting for good: it leaves the calendar, the CRM and (when it is still planned)
 * Google Calendar, where the guests are told. The timeline keeps a line that it was deleted.
 * To keep the record, cancel it instead.
 * @param {{ tellGuests?: boolean }} [options]
 */
export async function deleteMeeting(actor, meetingId, options = {}, context = {}) {
  const meeting = await loadMeetingForAction(actor, meetingId, 'delete');
  if (meeting.status === 'scheduled') {
    await pushToGoogle(meeting, 'remove', options.tellGuests ?? true);
  }
  await Meeting.deleteOne({ _id: meeting._id });
  await MeetingSummary.deleteOne({ meetingId: meeting._id });
  await onTimeline(meeting, actor._id, 'meeting_deleted', `Meeting deleted: ${meeting.title}`, {
    content: `It was planned for ${timeOf(meeting.startAt)}.`,
  });
  await writeAudit({
    actor,
    action: 'meeting.deleted',
    entityType: 'meetings',
    entityId: meeting._id,
    oldValue: { title: meeting.title, startAt: meeting.startAt, status: meeting.status },
    requestId: context.requestId,
  });
  announce();
  return { deleted: true };
}

/**
 * Remind our own people of meetings that start within half an hour. A background job calls
 * this every minute. Safe to run twice: a reminded meeting is marked, and notify() refuses
 * to tell the same thing again.
 * @param {Date} [now]  Only tests pass it
 */
export async function runMeetingReminders(now = new Date()) {
  const soon = new Date(now.getTime() + REMIND_BEFORE_MS);
  const due = await Meeting.find({
    status: 'scheduled',
    reminderSentAt: null,
    startAt: { $gt: now, $lte: soon },
  })
    .limit(200)
    .lean();
  for (const meeting of due) {
    for (const userId of [meeting.organizerId, ...meeting.internalAttendeeIds]) {
      await notify({
        userId,
        type: 'meeting_reminder',
        title: `Meeting at ${timeOf(meeting.startAt)}: ${meeting.title}`,
        body: meeting.meetLink ?? meeting.location ?? undefined,
        link: linkOf(meeting),
        dedupeKey: `meeting-reminder:${meeting._id}:${+meeting.startAt}:${userId}`,
      });
    }
    await Meeting.updateOne(
      { _id: meeting._id },
      { $set: { reminderSentAt: now } },
      { timestamps: false },
    );
  }
  return { reminded: due.length };
}
