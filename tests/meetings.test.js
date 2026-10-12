import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// Meetings and the Google Calendar of their organizer. Google is replaced by `fetch` below:
// a small pretend calendar that remembers every call and can be changed "in Google".
Object.assign(process.env, {
  GOOGLE_WORKSPACE_CLIENT_ID: 'workspace-client-id',
  GOOGLE_WORKSPACE_CLIENT_SECRET: 'workspace-client-secret',
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
});

const OWN = 'asha@engenx.in';
const calendar = { events: new Map(), changed: [], calls: [], isDown: false, tokenIsGone: false };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

/** Change the pretend calendar the way a person would in Google itself. */
function inGoogle(id, changes) {
  const event = { ...(calendar.events.get(id) ?? { id, status: 'confirmed' }), ...changes };
  calendar.events.set(id, event);
  calendar.changed.push(id);
  return event;
}

vi.stubGlobal('fetch', async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.host !== 'www.googleapis.com') return json({});
  const path = url.pathname.replace('/calendar/v3/calendars/primary', '');
  const method = options.method ?? 'GET';
  const body = options.body ? JSON.parse(options.body) : null;
  calendar.calls.push({ method, path, body, sendUpdates: url.searchParams.get('sendUpdates') });
  if (calendar.isDown) return json({ error: { message: 'Backend Error' } }, 500);

  if (method === 'POST' && path === '/events') {
    const id = `g${calendar.events.size + 1}`;
    const event = {
      id,
      status: 'confirmed',
      ...body,
      ...(body.conferenceData ? { hangoutLink: `https://meet.google.com/${id}` } : {}),
    };
    calendar.events.set(id, event);
    return json(event);
  }
  if (method === 'GET' && path === '/events') {
    if (url.searchParams.get('syncToken') && calendar.tokenIsGone) {
      calendar.tokenIsGone = false;
      return json({ error: { message: 'Sync token is no longer valid' } }, 410);
    }
    const ids = url.searchParams.get('syncToken') ? calendar.changed : [...calendar.events.keys()];
    const items = [...new Set(ids)].map((id) => calendar.events.get(id));
    calendar.changed = [];
    return json({ items, nextSyncToken: `token-${calendar.calls.length}` });
  }
  const id = path.replace('/events/', '');
  if (!calendar.events.has(id)) return json({ error: { message: 'Not Found' } }, 404);
  if (method === 'PATCH') return json(inGoogle(id, body));
  if (method === 'DELETE') {
    inGoogle(id, { status: 'cancelled' });
    return new Response(null, { status: 204 });
  }
  return json(calendar.events.get(id));
});

const { createApp } = await import('../app.js');
const { createSessionMiddleware } = await import('../middleware/session.js');
const { Activity } = await import('../models/activity.model.js');
const { Contact } = await import('../models/contact.model.js');
const { Meeting } = await import('../models/meeting.model.js');
const { Notification } = await import('../models/notification.model.js');
const { Role } = await import('../models/role.model.js');
const { User } = await import('../models/user.model.js');
const { runSeed, seedStartingLists, seedStatusLists } = await import('../seeds/seed.js');
const { loadRequestUser } = await import('../services/auth.service.js');
const { syncCalendar } = await import('../services/calendarSync.service.js');
const { completeConnect } = await import('../services/googleConnection.service.js');
const { runMeetingReminders } = await import('../services/meetings.service.js');
const { clearTestDb, startTestDbWithTransactions, stopTestDb } =
  await import('./helpers/testDb.js');

const PASSWORD = 'correct-horse-battery';
const CUSTOMER = 'asha.verma@bharatforge.example';
const HOUR = 60 * 60 * 1000;
const START = new Date(Date.now() + 48 * HOUR);
const at = (hours) => new Date(START.getTime() + hours * HOUR).toISOString();
let app;
let asha;
let omarId;
let asAsha;
let asOmar;
let asCeo;
let leadId;
let accountId;
let contactId;

async function signedInAs(user) {
  const client = request.agent(app);
  const response = await client
    .post('/api/auth/login')
    .send({ email: user.email, password: PASSWORD });
  expect(response.status).toBe(200);
  return client;
}
const plan = (extra = {}) => ({
  title: 'Pilot scope',
  mode: 'online',
  startAt: at(0),
  endAt: at(1),
  opportunityId: leadId,
  contactIds: [contactId],
  ...extra,
});
const googleCalls = (method) => calendar.calls.filter((call) => call.method === method);
const titlesOnTimeline = async () =>
  (await Activity.find({ type: 'MEETING' }).sort({ _id: 1 }).lean()).map((entry) => entry.title);

beforeAll(async () => {
  await startTestDbWithTransactions(); // creating a lead uses a transaction
  app = createApp({ sessionMiddleware: createSessionMiddleware() });
});
afterAll(stopTestDb);

beforeEach(async () => {
  await clearTestDb();
  Object.assign(calendar, {
    events: new Map(),
    changed: [],
    calls: [],
    isDown: false,
    tokenIsGone: false,
  });
  await runSeed({ productName: 'P', companyName: 'C', workspaceDomain: 'engenx.in' });
  await seedStatusLists();
  await seedStartingLists();
  const roles = Object.fromEntries((await Role.find()).map((role) => [role.name, role]));
  const makeUser = (email, name, roleName) =>
    User.create({
      email,
      name,
      roleId: roles[roleName]._id,
      status: 'active',
      password: PASSWORD,
      isWorkspaceAccount: true,
    });
  const [first, second, third] = await Promise.all([
    makeUser(OWN, 'Asha Agent', 'Sales Agent'),
    makeUser('omar@engenx.in', 'Omar Agent', 'Sales Agent'),
    makeUser('ceo@engenx.in', 'Kunal CEO', 'CEO'),
  ]);
  [asAsha, asOmar, asCeo] = await Promise.all([first, second, third].map(signedInAs));
  asha = await loadRequestUser(first._id);
  omarId = String(second._id);

  const created = await asAsha.post('/api/accounts/quick-add').send({
    account: { name: 'Bharat Forge' },
    contacts: [{ name: 'Asha Verma', email: CUSTOMER }],
    lead: { name: 'OEE for press line' },
  });
  accountId = created.body.data.account.id;
  leadId = created.body.data.lead.id;
  contactId = String((await Contact.findOne({ email: CUSTOMER }).lean())._id);
  await completeConnect(asha, {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresInSec: 3600,
    scopes: [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/calendar.events',
    ],
    googleEmail: OWN,
    hostedDomain: 'engenx.in',
  });
});

describe('planning a meeting', () => {
  it('is saved, goes into my Google Calendar with a Meet link, and shows on the timeline', async () => {
    const created = await asAsha
      .post('/api/meetings')
      .send(plan({ internalAttendeeIds: [omarId] }));
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      title: 'Pilot scope',
      mode: 'online',
      status: 'scheduled',
      organizer: { name: 'Asha Agent' },
      colleagues: [{ id: omarId, name: 'Omar Agent' }],
      attendees: [{ contactId, name: 'Asha Verma', email: CUSTOMER, response: 'needsAction' }],
      account: { name: 'Bharat Forge' },
      lead: { name: 'OEE for press line' },
      meetLink: 'https://meet.google.com/g1',
      isInGoogleCalendar: true,
      googleSyncError: null,
    });

    const [insert] = googleCalls('POST');
    expect(insert.sendUpdates).toBe('all');
    expect(insert.body.summary).toBe('Pilot scope');
    expect(insert.body.attendees.map((guest) => guest.email)).toEqual([CUSTOMER, 'omar@engenx.in']);
    expect(insert.body.conferenceData.createRequest.conferenceSolutionKey.type).toBe(
      'hangoutsMeet',
    );
    expect(new Date(insert.body.start.dateTime).toISOString()).toBe(at(0));

    expect(await titlesOnTimeline()).toEqual(['Meeting planned: Pilot scope']);
    const told = await Notification.find({ type: 'meeting_invite' }).lean();
    expect(told.map((item) => [String(item.userId), item.title])).toEqual([
      [omarId, 'Asha Agent invited you to a meeting'],
    ]);
  });

  it('refuses a wrong time and people of another company; a visit gets no Meet link', async () => {
    expect((await asAsha.post('/api/meetings').send(plan({ endAt: at(-1) }))).status).toBe(400);
    expect((await asAsha.post('/api/meetings').send(plan({ title: ' ' }))).status).toBe(400);
    const other = await asAsha.post('/api/accounts/quick-add').send({
      account: { name: 'Other Works' },
      contacts: [{ name: 'Someone Else', email: 'someone@other.example' }],
    });
    const stranger = String((await Contact.findOne({ email: 'someone@other.example' }).lean())._id);
    expect(other.status).toBe(201);
    expect((await asAsha.post('/api/meetings').send(plan({ contactIds: [stranger] }))).status).toBe(
      400,
    );
    expect(await Meeting.countDocuments()).toBe(0);

    const visit = await asAsha
      .post('/api/meetings')
      .send(plan({ mode: 'plant_visit', location: 'Pune plant', tellGuests: false }));
    expect(visit.body.data).toMatchObject({ mode: 'plant_visit', meetLink: null });
    expect(googleCalls('POST')[0].body.conferenceData).toBeUndefined();
    expect(googleCalls('POST')[0].sendUpdates).toBe('none');
  });

  it('without a connected calendar, or with Google down, the meeting is still kept', async () => {
    // Omar has no calendar connected: his meeting lives in the CRM only.
    const mine = await asOmar
      .post('/api/meetings')
      .send({ title: 'Internal prep', mode: 'physical', startAt: at(0), endAt: at(1) });
    expect(mine.status).toBe(201);
    expect(mine.body.data).toMatchObject({ isInGoogleCalendar: false, googleSyncError: null });
    expect(calendar.calls).toHaveLength(0);

    calendar.isDown = true;
    const kept = await asAsha.post('/api/meetings').send(plan());
    expect(kept.status).toBe(201);
    expect(kept.body.data.isInGoogleCalendar).toBe(false);
    expect(kept.body.data.googleSyncError).toContain('Backend Error');
  });
});

describe('who sees a meeting', () => {
  it('the organizer, the invited, the manager line, and whoever may see its lead', async () => {
    const withOmar = (await asAsha.post('/api/meetings').send(plan({ title: 'About the lead' })))
      .body.data;
    const internal = (
      await asAsha.post('/api/meetings').send({
        title: 'Team sync',
        mode: 'physical',
        startAt: at(3),
        endAt: at(4),
        internalAttendeeIds: [omarId],
      })
    ).body.data;
    const span = `?from=${at(-24)}&to=${at(24)}`;
    const titles = async (client, query = span) =>
      (await client.get(`/api/meetings${query}`)).body.data.map((meeting) => meeting.title);

    expect(await titles(asAsha)).toEqual(['About the lead', 'Team sync']);
    expect(await titles(asCeo)).toEqual(['About the lead', 'Team sync']);
    // Omar is invited to the internal one; the lead's meeting is not his to see.
    expect(await titles(asOmar)).toEqual(['Team sync']);
    expect((await asOmar.get(`/api/meetings/${withOmar.id}`)).status).toBe(404);
    expect((await asOmar.get(`/api/meetings/${internal.id}`)).status).toBe(200);
    // Invited is not organizer: he can look, not change.
    expect(
      (await asOmar.patch(`/api/meetings/${internal.id}`).send({ title: 'Mine now' })).status,
    ).toBe(403);

    // On the page of the lead and of the company.
    expect(await titles(asAsha, `?opportunityId=${leadId}`)).toEqual(['About the lead']);
    expect(await titles(asCeo, `?accountId=${accountId}`)).toEqual(['About the lead']);
    expect((await asOmar.get(`/api/meetings?opportunityId=${leadId}`)).status).toBe(404);
    expect((await asAsha.get('/api/meetings')).status).toBe(400); // no days given
  });
});

describe('moving and closing', () => {
  it('a new time moves it in Google; held with notes; afterwards only the notes change', async () => {
    const meeting = (await asAsha.post('/api/meetings').send(plan())).body.data;
    await Meeting.updateOne({ _id: meeting.id }, { $set: { reminderSentAt: new Date() } });

    const moved = await asAsha
      .patch(`/api/meetings/${meeting.id}`)
      .send({ startAt: at(2), endAt: at(3) });
    expect(moved.status).toBe(200);
    expect(new Date(moved.body.data.startAt).toISOString()).toBe(at(2));
    const [patch] = googleCalls('PATCH');
    expect(patch.path).toBe('/events/g1');
    expect(new Date(patch.body.start.dateTime).toISOString()).toBe(at(2));
    expect((await Meeting.findById(meeting.id).lean()).reminderSentAt).toBeUndefined();
    expect((await asAsha.patch(`/api/meetings/${meeting.id}`).send({ endAt: at(1) })).status).toBe(
      400,
    ); // would end before it starts

    const held = await asAsha
      .post(`/api/meetings/${meeting.id}/close`)
      .send({ status: 'completed', notes: 'They want a pilot on one press.' });
    expect(held.body.data).toMatchObject({
      status: 'completed',
      notes: 'They want a pilot on one press.',
    });
    expect(await titlesOnTimeline()).toEqual([
      'Meeting planned: Pilot scope',
      'Meeting moved',
      'Meeting held: Pilot scope',
    ]);

    expect(
      (await asAsha.patch(`/api/meetings/${meeting.id}`).send({ title: 'Other' })).status,
    ).toBe(409);
    expect(
      (await asAsha.post(`/api/meetings/${meeting.id}/close`).send({ status: 'cancelled' })).status,
    ).toBe(409);
    const noted = await asAsha
      .patch(`/api/meetings/${meeting.id}`)
      .send({ notes: 'They want a pilot on two presses.' });
    expect(noted.body.data.notes).toBe('They want a pilot on two presses.');
  });

  it('a cancelled meeting leaves Google Calendar', async () => {
    const meeting = (await asAsha.post('/api/meetings').send(plan())).body.data;
    const cancelled = await asAsha
      .post(`/api/meetings/${meeting.id}/close`)
      .send({ status: 'cancelled', notes: 'The customer asked to wait.' });
    expect(cancelled.body.data.status).toBe('cancelled');
    expect(googleCalls('DELETE').map((call) => call.path)).toEqual(['/events/g1']);
    expect(await titlesOnTimeline()).toEqual([
      'Meeting planned: Pilot scope',
      'Meeting cancelled: Pilot scope',
    ]);
  });
});

describe('changes made in Google Calendar', () => {
  it('a new time, an answer and a cancellation come back into the CRM', async () => {
    const meeting = (await asAsha.post('/api/meetings').send(plan())).body.data;
    await syncCalendar(asha._id); // the first look: nothing differs

    inGoogle('g1', {
      start: { dateTime: at(5) },
      end: { dateTime: at(6) },
      attendees: [
        { email: CUSTOMER, responseStatus: 'accepted' },
        { email: OWN, self: true, responseStatus: 'accepted' },
      ],
    });
    expect(await syncCalendar(asha._id)).toEqual({ events: 1, changed: 1 });
    const moved = (await asAsha.get(`/api/meetings/${meeting.id}`)).body.data;
    expect(new Date(moved.startAt).toISOString()).toBe(at(5));
    expect(moved.attendees).toMatchObject([{ email: CUSTOMER, response: 'accepted' }]);
    // The change that just came from Google is not sent back to it.
    expect(googleCalls('PATCH')).toHaveLength(0);
    expect(await syncCalendar(asha._id)).toEqual({ events: 0, changed: 0 });

    inGoogle('g1', { status: 'cancelled' });
    await syncCalendar(asha._id);
    expect((await Meeting.findById(meeting.id).lean()).status).toBe('cancelled');
    expect((await titlesOnTimeline()).at(-1)).toBe('Meeting cancelled: Pilot scope');
  });

  it('an event made in Google becomes a meeting only when a person of the CRM is a guest', async () => {
    await syncCalendar(asha._id);
    inGoogle('own-1', {
      summary: 'Call with Bharat Forge',
      start: { dateTime: at(0) },
      end: { dateTime: at(1) },
      hangoutLink: 'https://meet.google.com/own-1',
      attendees: [{ email: CUSTOMER }, { email: OWN, self: true }],
    });
    inGoogle('private-1', {
      summary: 'Dentist',
      start: { dateTime: at(2) },
      end: { dateTime: at(3) },
    });
    inGoogle('internal-1', {
      summary: 'Team lunch',
      start: { dateTime: at(4) },
      end: { dateTime: at(5) },
      attendees: [{ email: 'omar@engenx.in' }],
    });
    inGoogle('all-day-1', {
      summary: 'Trade fair',
      start: { date: '2026-11-02' },
      end: { date: '2026-11-03' },
      attendees: [{ email: CUSTOMER }],
    });
    expect(await syncCalendar(asha._id)).toEqual({ events: 4, changed: 1 });

    const kept = await Meeting.find().lean();
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({
      title: 'Call with Bharat Forge',
      mode: 'online',
      bookedVia: 'google',
      googleEventId: 'own-1',
      meetLink: 'https://meet.google.com/own-1',
    });
    expect(String(kept[0].accountId)).toBe(accountId);
    expect(String(kept[0].attendees[0].contactId)).toBe(contactId);

    // Google forgot where we stood: everything is looked at again, and nothing is doubled.
    calendar.tokenIsGone = true;
    await syncCalendar(asha._id);
    expect(await Meeting.countDocuments()).toBe(1);
    // Someone without a connection is skipped.
    expect(await syncCalendar(omarId)).toEqual({ skipped: 'not connected' });
  });
});

describe('reminders', () => {
  it('our people are told once, half an hour before', async () => {
    const meeting = (
      await asAsha.post('/api/meetings').send(plan({ internalAttendeeIds: [omarId] }))
    ).body.data;
    const reminders = () => Notification.find({ type: 'meeting_reminder' }).lean();

    expect(await runMeetingReminders(new Date(START.getTime() - 2 * HOUR))).toEqual({
      reminded: 0,
    });
    const soon = new Date(START.getTime() - 20 * 60 * 1000);
    expect(await runMeetingReminders(soon)).toEqual({ reminded: 1 });
    expect(await runMeetingReminders(soon)).toEqual({ reminded: 0 });
    const told = await reminders();
    expect(told.map((item) => String(item.userId)).sort()).toEqual(
      [String(asha._id), omarId].sort(),
    );
    expect(told[0].link).toBe(`/calendar?meeting=${meeting.id}`);
    expect(told[0].body).toBe('https://meet.google.com/g1');
  });
});
