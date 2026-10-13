import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

// The kinds of meeting (Settings), a person's booking page, and what the public may see and
// do on it. No Google Calendar is connected here: busy times come from the CRM's own meetings.

const { createApp } = await import('../app.js');
const { createSessionMiddleware } = await import('../middleware/session.js');
const { Meeting } = await import('../models/meeting.model.js');
const { Notification } = await import('../models/notification.model.js');
const { Role } = await import('../models/role.model.js');
const { User } = await import('../models/user.model.js');
const { runSeed, seedStartingLists, seedStatusLists } = await import('../seeds/seed.js');
const { clearTestDb, startTestDbWithTransactions, stopTestDb } =
  await import('./helpers/testDb.js');

const PASSWORD = 'correct-horse-battery';
const DAY = 24 * 60 * 60 * 1000;
let app;
let asAsha;
let asCeo;
let ashaId;
let online; // the bookable kind of meeting: 30 minutes, online
let slug;

/** The next Monday that is at least three days away, as an India day "YYYY-MM-DD". */
function aMonday() {
  const india = (date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);
  for (let ahead = 3; ahead < 11; ahead += 1) {
    const day = india(new Date(Date.now() + ahead * DAY));
    if (new Date(`${day}T12:00:00+05:30`).getUTCDay() === 1) return day;
  }
  throw new Error('no Monday found');
}
const MONDAY = aMonday();
const at = (time, day = MONDAY) => new Date(`${day}T${time}:00+05:30`).toISOString();
const dayAfter = (day, count) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
    new Date(new Date(`${day}T12:00:00+05:30`).getTime() + count * DAY),
  );
const anyone = () => request(app); // no sign-in
const slotsOf = async (day = MONDAY, typeId = online.id) =>
  (await anyone().get(`/api/public/booking/${slug}/slots?typeId=${typeId}&date=${day}`)).body.data
    ?.slots;
const book = (body) =>
  anyone()
    .post(`/api/public/booking/${slug}/book`)
    .send({ typeId: online.id, name: 'Vikram Rao', email: 'vikram@newfoundry.example', ...body });

async function signedInAs(user) {
  const client = request.agent(app);
  const response = await client
    .post('/api/auth/login')
    .send({ email: user.email, password: PASSWORD });
  expect(response.status).toBe(200);
  return client;
}

beforeAll(async () => {
  await startTestDbWithTransactions(); // creating a lead uses a transaction
  app = createApp({ sessionMiddleware: createSessionMiddleware() });
});
afterAll(stopTestDb);

beforeEach(async () => {
  await clearTestDb();
  await runSeed({ productName: 'P', companyName: 'C', workspaceDomain: 'engenx.in' });
  await seedStatusLists();
  await seedStartingLists();
  const roles = Object.fromEntries((await Role.find()).map((role) => [role.name, role]));
  const makeUser = (email, name, roleName) =>
    User.create({ email, name, roleId: roles[roleName]._id, status: 'active', password: PASSWORD });
  const [asha, ceo] = await Promise.all([
    makeUser('asha@engenx.in', 'Asha Agent', 'Sales Agent'),
    makeUser('ceo@engenx.in', 'Kunal CEO', 'CEO'),
  ]);
  ashaId = String(asha._id);
  [asAsha, asCeo] = await Promise.all([asha, ceo].map(signedInAs));
  const types = (await asAsha.get('/api/meeting-types')).body.data;
  online = types.find((type) => type.isBookable);
  slug = (await asAsha.get('/api/booking-page')).body.data.slug;
});

describe('meeting types', () => {
  it('start as three kinds; managed by the people who manage the settings', async () => {
    const types = (await asAsha.get('/api/meeting-types')).body.data;
    expect(
      types.map((type) => [type.name, type.mode, type.durationMinutes, type.isBookable]),
    ).toEqual([
      ['Online meeting', 'online', 30, true],
      ['Meeting in person', 'physical', 60, false],
      ['Plant visit', 'plant_visit', 120, false],
    ]);
    const demo = { name: 'Product demo', mode: 'online', durationMinutes: 45, isBookable: true };
    expect((await asAsha.post('/api/meeting-types').send(demo)).status).toBe(403);
    const made = await asCeo.post('/api/meeting-types').send(demo);
    expect(made.status).toBe(201);
    expect((await asCeo.post('/api/meeting-types').send(demo)).status).toBe(409);
    expect(
      (await asCeo.post('/api/meeting-types').send({ ...demo, name: 'X', durationMinutes: 5 }))
        .status,
    ).toBe(400);
    const off = await asCeo
      .patch(`/api/meeting-types/${made.body.data.id}`)
      .send({ isActive: false });
    expect(off.body.data.isActive).toBe(false);

    // A kind that a meeting uses cannot be deleted.
    await asAsha.post('/api/meetings').send({
      title: 'Internal',
      typeId: online.id,
      mode: 'online',
      startAt: at('15:00'),
      endAt: at('15:30'),
    });
    expect((await asCeo.delete(`/api/meeting-types/${online.id}`)).status).toBe(409);
    expect((await asCeo.delete(`/api/meeting-types/${made.body.data.id}`)).status).toBe(200);
  });
});

describe('the public booking page', () => {
  it('does not exist for the public until its owner switches it on', async () => {
    const mine = (await asAsha.get('/api/booking-page')).body.data;
    expect(mine).toMatchObject({ isActive: false, bufferMinutes: 15, maxDaysAhead: 30 });
    expect(mine.availability).toHaveLength(5); // Monday to Friday
    expect((await anyone().get(`/api/public/booking/${slug}`)).status).toBe(404);
    expect((await book({ startAt: at('10:00') })).status).toBe(404);

    await asAsha.patch('/api/booking-page').send({ isActive: true, intro: 'Pick a time.' });
    const page = await anyone().get(`/api/public/booking/${slug}`);
    expect(page.body.data).toEqual({
      ownerName: 'Asha Agent',
      intro: 'Pick a time.',
      maxDaysAhead: 30,
      types: [{ id: online.id, name: 'Online meeting', mode: 'online', durationMinutes: 30 }],
    });
    // Only kinds that are marked as bookable can be offered.
    const visit = (await asAsha.get('/api/meeting-types')).body.data.find(
      (type) => type.mode === 'plant_visit',
    );
    expect(
      (await asAsha.patch('/api/booking-page').send({ meetingTypeIds: [visit.id] })).status,
    ).toBe(400);
    expect((await anyone().get('/api/booking-page')).status).toBe(401);
  });

  it('shows only free times: inside the hours, around meetings with the buffer', async () => {
    await asAsha.patch('/api/booking-page').send({ isActive: true });
    const times = (slots) =>
      slots.map((slot) =>
        new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Asia/Kolkata',
          hour: '2-digit',
          minute: '2-digit',
        }).format(new Date(slot)),
      );
    const all = times(await slotsOf());
    expect(all).toHaveLength(16); // 10:00 to 18:00 in half hours
    expect([all[0], all.at(-1)]).toEqual(['10:00', '17:30']);

    // A meeting from 11:00 to 12:00, with 15 minutes kept free on both sides.
    await asAsha.post('/api/meetings').send({
      title: 'Internal',
      mode: 'physical',
      startAt: at('11:00'),
      endAt: at('12:00'),
    });
    const around = times(await slotsOf());
    expect(around.slice(0, 3)).toEqual(['10:00', '12:30', '13:00']);
    expect(around).toHaveLength(12);

    expect(await slotsOf(dayAfter(MONDAY, -1))).toEqual([]); // a Sunday
    expect(await slotsOf(dayAfter(MONDAY, 35))).toEqual([]); // further ahead than the page allows
    expect(
      (await anyone().get(`/api/public/booking/${slug}/slots?typeId=${online.id}&date=soon`))
        .status,
    ).toBe(400);
    // A cancelled meeting gives its time back.
    const [meeting] = await Meeting.find().lean();
    await asAsha.post(`/api/meetings/${meeting._id}/close`).send({ status: 'cancelled' });
    expect(await slotsOf()).toHaveLength(16);
  });

  it('a booking plans the meeting in the owner’s name, once', async () => {
    await asAsha.patch('/api/booking-page').send({ isActive: true });
    const booked = await book({ startAt: at('10:00'), company: 'New Foundry', note: 'OEE.' });
    expect(booked.status).toBe(201);
    expect(booked.body.data).toMatchObject({
      ownerName: 'Asha Agent',
      typeName: 'Online meeting',
      mode: 'online',
    });
    expect(new Date(booked.body.data.endAt).toISOString()).toBe(at('10:30'));

    const meeting = await Meeting.findOne().lean();
    expect(meeting).toMatchObject({
      title: 'Online meeting with Vikram Rao',
      bookedVia: 'booking_page',
      status: 'scheduled',
    });
    expect(String(meeting.organizerId)).toBe(ashaId);
    expect(meeting.attendees).toMatchObject([
      { email: 'vikram@newfoundry.example', name: 'Vikram Rao' },
    ]);
    expect(meeting.agenda).toContain('Company: New Foundry');
    const told = await Notification.find({ type: 'meeting_booked' }).lean();
    expect(told.map((item) => item.title)).toEqual(['Vikram Rao booked a meeting with you']);

    // The same time again, a time that is not offered, and a broken request.
    expect((await book({ startAt: at('10:00') })).status).toBe(409);
    expect((await book({ startAt: at('10:10') })).status).toBe(409);
    expect((await book({ startAt: at('09:00') })).status).toBe(409);
    expect((await book({ startAt: at('14:00'), email: 'not-an-address' })).status).toBe(400);
    expect(await Meeting.countDocuments()).toBe(1);
  });

  it('a person who is in the CRM is linked to their company', async () => {
    await asAsha.patch('/api/booking-page').send({ isActive: true });
    const created = await asAsha.post('/api/accounts/quick-add').send({
      account: { name: 'Bharat Forge' },
      contacts: [{ name: 'Asha Verma', email: 'asha.verma@bharatforge.example' }],
    });
    const booked = await book({
      startAt: at('16:00'),
      name: 'Asha V',
      email: 'Asha.Verma@BharatForge.example',
    });
    expect(booked.status).toBe(201);
    const meeting = await Meeting.findOne().lean();
    expect(String(meeting.accountId)).toBe(created.body.data.account.id);
    expect(meeting.attendees).toMatchObject([{ name: 'Asha Verma' }]);
    expect(meeting.attendees[0].contactId).toBeTruthy();
  });
});
