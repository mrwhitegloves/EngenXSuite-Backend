import { SOCKET_EVENTS } from '../constants/socketEvents.js';
import { listChangedEvents } from '../integrations/google/calendar.js';
import { logger } from '../infra/logger.js';
import { emitToAll } from '../infra/realtime.js';
import { createAppError } from '../lib/errors.js';
import { Contact } from '../models/contact.model.js';
import { Account } from '../models/account.model.js';
import { Meeting } from '../models/meeting.model.js';
import { UserGoogleConnection } from '../models/userGoogleConnection.model.js';
import { recordActivity } from './activities.service.js';
import { getGoogleAccessToken } from './googleConnection.service.js';

// Bringing changes from the company's Google Calendar (decision 0014) into the CRM.
//
//   - An event that IS a meeting of the CRM: a new time, title or place, the guests' answers
//     and a cancellation are taken over.
//   - An event made in Google itself becomes a meeting ONLY when one of its guests is a person
//     who is in the CRM. Everything else in a calendar (private and internal events) is never
//     stored, the same rule as for mail.
//   - All-day events are left alone.
// Safe to run twice: an event is one meeting (unique index), and an unchanged event changes nothing.

const sameTime = (a, b) => +new Date(a) === +new Date(b);

/** The guests of an event as the meeting keeps them, with the CRM contact when there is one. */
function toAttendees(event, contactsByEmail) {
  return event.attendees
    .filter((person) => !person.isSelf && contactsByEmail.has(person.email))
    .map((person) => {
      const contact = contactsByEmail.get(person.email);
      return {
        contactId: contact._id,
        email: person.email,
        name: contact.name,
        response: person.response,
      };
    });
}

async function applyToMeeting(meeting, event, contactsByEmail) {
  if (event.isCancelled) {
    if (meeting.status !== 'scheduled') return false;
    await Meeting.updateOne({ _id: meeting._id }, { $set: { status: 'cancelled' } });
    if (meeting.accountId || meeting.opportunityId) {
      await recordActivity({
        type: 'MEETING',
        direction: 'internal',
        subtype: 'meeting_cancelled',
        title: `Meeting cancelled: ${meeting.title}`,
        content: 'Cancelled in Google Calendar.',
        accountId: meeting.accountId,
        opportunityId: meeting.opportunityId,
        userId: meeting.organizerId,
        refCollection: 'meetings',
        refId: meeting._id,
      });
    }
    return true;
  }
  if (!event.startAt || !event.endAt) return false;
  const set = {};
  if (event.title && event.title !== meeting.title) set.title = event.title;
  if (!sameTime(event.startAt, meeting.startAt)) set.startAt = event.startAt;
  if (!sameTime(event.endAt, meeting.endAt)) set.endAt = event.endAt;
  if ((event.location ?? null) !== (meeting.location ?? null)) set.location = event.location;
  if (event.meetLink && event.meetLink !== meeting.meetLink) set.meetLink = event.meetLink;
  // The guests' answers; people of the CRM who were added in Google join the list.
  const answers = new Map(event.attendees.map((person) => [person.email, person.response]));
  const known = new Set(meeting.attendees.map((person) => person.email).filter(Boolean));
  const attendees = [
    ...meeting.attendees.map((person) => ({
      ...person,
      response: answers.get(person.email) ?? person.response,
    })),
    ...toAttendees(event, contactsByEmail).filter((person) => !known.has(person.email)),
  ];
  if (JSON.stringify(attendees) !== JSON.stringify(meeting.attendees)) set.attendees = attendees;
  if (Object.keys(set).length === 0) return false;
  await Meeting.updateOne(
    { _id: meeting._id },
    { $set: set, ...(set.startAt ? { $unset: { reminderSentAt: 1 } } : {}) },
  );
  return true;
}

/**
 * An event made in Google, with a person of the CRM as a guest, becomes a meeting. It is put on
 * the owner of that person's company (else on the person the mailbox is stored under).
 */
async function adoptEvent(mailboxUserId, event, contactsByEmail, now) {
  if (event.isCancelled || !event.startAt || !event.endAt || event.endAt < now) return false;
  const attendees = toAttendees(event, contactsByEmail);
  if (attendees.length === 0) return false;
  const first = contactsByEmail.get(attendees[0].email);
  const company = await Account.findById(first.accountId).select('ownerId').lean();
  const userId = company?.ownerId ?? mailboxUserId;
  let meeting;
  try {
    meeting = await Meeting.create({
      title: event.title || 'Meeting',
      mode: event.meetLink ? 'online' : 'physical',
      startAt: event.startAt,
      endAt: event.endAt,
      location: event.location ?? undefined,
      meetLink: event.meetLink ?? undefined,
      organizerId: userId,
      createdBy: userId,
      attendees,
      accountId: first.accountId,
      bookedVia: 'google',
      googleEventId: event.id,
    });
  } catch (error) {
    if (error?.code === 11000) return false; // another run stored it a moment ago
    throw error;
  }
  await recordActivity({
    type: 'MEETING',
    direction: 'internal',
    subtype: 'meeting_planned',
    title: `Meeting planned: ${meeting.title}`,
    content: 'From Google Calendar.',
    accountId: first.accountId,
    contactId: first._id,
    userId,
    refCollection: 'meetings',
    refId: meeting._id,
  });
  return true;
}

/**
 * Bring the company calendar's changes into the CRM.
 * @param {Date} [now]  Only tests pass it
 * @returns {Promise<{ skipped?: string, events?: number, changed?: number }>}
 */
export async function syncCalendar(now = new Date()) {
  const connection = await UserGoogleConnection.findOne({ status: 'connected' }).lean();
  if (!connection) return { skipped: 'not connected' };
  const token = await getGoogleAccessToken();
  let page;
  try {
    page = await listChangedEvents(token, {
      syncToken: connection.calendar?.syncToken,
      since: now,
    });
  } catch (error) {
    // Google forgot where we stood: look at everything from now on again.
    if (error?.code !== 'CALENDAR_GONE' || !connection.calendar?.syncToken) throw error;
    page = await listChangedEvents(token, { since: now });
  }

  const emails = [...new Set(page.events.flatMap((event) => event.attendees.map((p) => p.email)))];
  const contacts = emails.length
    ? await Contact.find({ email: { $in: emails }, deletedAt: null })
        .select('name email accountId')
        .lean()
    : [];
  const contactsByEmail = new Map(contacts.map((contact) => [contact.email, contact]));

  let changed = 0;
  for (const event of page.events) {
    try {
      const meeting = await Meeting.findOne({ googleEventId: event.id }).lean();
      const didChange = meeting
        ? await applyToMeeting(meeting, event, contactsByEmail)
        : await adoptEvent(connection.userId, event, contactsByEmail, now);
      if (didChange) changed += 1;
    } catch (error) {
      logger.warn({ err: error }, 'A calendar event was not taken over');
    }
  }
  await UserGoogleConnection.updateOne(
    { _id: connection._id },
    {
      $set: {
        'calendar.lastSyncAt': now,
        ...(page.syncToken ? { 'calendar.syncToken': page.syncToken } : {}),
      },
    },
  );
  if (changed > 0) emitToAll(SOCKET_EVENTS.meetingsChanged);
  return { events: page.events.length, changed };
}

/** Read the company calendar now (the button on the Calendar screen). */
export async function requestCalendarSync() {
  const result = await syncCalendar();
  if (result.skipped) {
    throw createAppError(
      'GOOGLE_NOT_CONNECTED',
      409,
      'The company calendar is not connected. Someone who manages the settings connects it under Mail and calendar.',
    );
  }
  return result;
}
