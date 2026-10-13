import { randomUUID } from 'node:crypto';
import { createAppError } from '../../lib/errors.js';

// The only file that talks to the Google Calendar API. Every function takes a working access
// token of one person (from getGoogleAccessToken) and works on THEIR own main calendar only.
// What becomes a meeting in the CRM is decided by services/calendarSync.service.js.

const BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary';

async function call(token, path, { method = 'GET', body, query } = {}) {
  const url = new URL(`${BASE}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw createAppError(
      'GOOGLE_UNREACHABLE',
      502,
      'Google Calendar could not be reached. Try again.',
    );
  }
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) {
    const isGone = response.status === 404 || response.status === 410;
    throw createAppError(
      isGone ? 'CALENDAR_GONE' : 'CALENDAR_ERROR',
      isGone ? 404 : 502,
      `Google Calendar refused the request: ${String(answer?.error?.message ?? response.status).slice(0, 200)}`,
    );
  }
  return answer;
}

/** A Google event as the CRM reads it. `startAt` is null for an all-day event. */
function toEvent(item) {
  const meet = item.conferenceData?.entryPoints?.find((point) => point.entryPointType === 'video');
  return {
    id: item.id,
    isCancelled: item.status === 'cancelled',
    title: String(item.summary ?? '').slice(0, 200),
    startAt: item.start?.dateTime ? new Date(item.start.dateTime) : null,
    endAt: item.end?.dateTime ? new Date(item.end.dateTime) : null,
    location: item.location ? String(item.location).slice(0, 300) : null,
    meetLink: item.hangoutLink ?? meet?.uri ?? null,
    attendees: (item.attendees ?? [])
      .filter((person) => person.email && !person.resource)
      .map((person) => ({
        email: String(person.email).toLowerCase(),
        name: person.displayName ?? null,
        response: person.responseStatus ?? 'needsAction',
        isSelf: Boolean(person.self),
      })),
  };
}

/** What Google needs for an event, from a meeting of the CRM. */
function toBody(meeting) {
  return {
    summary: meeting.title,
    description: meeting.agenda || undefined,
    location: meeting.location || undefined,
    start: { dateTime: meeting.startAt.toISOString() },
    end: { dateTime: meeting.endAt.toISOString() },
    attendees: meeting.guests.map((guest) => ({ email: guest.email, displayName: guest.name })),
    guestsCanInviteOthers: meeting.guestOptions?.canInviteOthers ?? true,
    guestsCanModify: meeting.guestOptions?.canModify ?? false,
    guestsCanSeeOtherGuests: meeting.guestOptions?.canSeeGuests ?? true,
  };
}

/** Asks Google to make a Meet link for the event. */
const meetRequest = () => ({
  conferenceData: {
    createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } },
  },
});

/**
 * Put a meeting into the person's calendar.
 * @param {{ title: string, agenda?: string, location?: string, startAt: Date, endAt: Date,
 *           guests: { email: string, name?: string }[] }} meeting
 * @param {{ withMeet?: boolean, tellGuests?: boolean }} [options]
 *        withMeet: also make a Google Meet link. tellGuests: Google mails the invitation
 * @returns {Promise<{ id: string, meetLink: string | null }>}
 */
export async function insertEvent(token, meeting, { withMeet = false, tellGuests = true } = {}) {
  const created = await call(token, '/events', {
    method: 'POST',
    query: { conferenceDataVersion: withMeet ? 1 : 0, sendUpdates: tellGuests ? 'all' : 'none' },
    body: {
      ...toBody(meeting),
      ...(withMeet ? meetRequest() : {}),
    },
  });
  return { id: created.id, meetLink: toEvent(created).meetLink };
}

/**
 * Change an event that is in the calendar already.
 * withMeet: also make a Meet link (for a meeting that became an online one).
 * @returns {Promise<{ meetLink: string | null }>}
 */
export async function patchEvent(
  token,
  eventId,
  meeting,
  { withMeet = false, tellGuests = true } = {},
) {
  const changed = await call(token, `/events/${eventId}`, {
    method: 'PATCH',
    query: { conferenceDataVersion: withMeet ? 1 : 0, sendUpdates: tellGuests ? 'all' : 'none' },
    body: { ...toBody(meeting), ...(withMeet ? meetRequest() : {}) },
  });
  return { meetLink: toEvent(changed).meetLink };
}

/** Take an event out of the calendar. One that is gone already is fine. */
export async function removeEvent(token, eventId, { tellGuests = true } = {}) {
  try {
    await call(token, `/events/${eventId}`, {
      method: 'DELETE',
      query: { sendUpdates: tellGuests ? 'all' : 'none' },
    });
  } catch (error) {
    if (error?.code !== 'CALENDAR_GONE') throw error;
  }
}

/**
 * The events that changed since the last look (`syncToken`), or, on a first look, every event
 * from `since` on. Throws CALENDAR_GONE when Google no longer knows the token: look again
 * without it.
 * @returns {Promise<{ events: ReturnType<typeof toEvent>[], syncToken: string | null }>}
 */
export async function listChangedEvents(token, { syncToken, since }) {
  const events = [];
  let pageToken;
  let next = null;
  do {
    const page = await call(token, '/events', {
      query: {
        singleEvents: true,
        showDeleted: true,
        maxResults: 250,
        pageToken,
        ...(syncToken ? { syncToken } : { timeMin: since.toISOString() }),
      },
    });
    events.push(...(page.items ?? []).map(toEvent));
    pageToken = page.nextPageToken;
    next = page.nextSyncToken ?? next;
  } while (pageToken);
  return { events, syncToken: next };
}

/**
 * When the person is busy between two moments, by their main calendar. Only the times: what
 * they are busy with is not asked for.
 * @returns {Promise<{ from: Date, to: Date }[]>}
 */
export async function getBusyTimes(token, { from, to }) {
  let response;
  try {
    response = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        items: [{ id: 'primary' }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw createAppError('GOOGLE_UNREACHABLE', 502, 'Google Calendar could not be reached.');
  }
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw createAppError('CALENDAR_ERROR', 502, 'Google Calendar refused the request.');
  }
  return (answer.calendars?.primary?.busy ?? []).map((item) => ({
    from: new Date(item.start),
    to: new Date(item.end),
  }));
}
