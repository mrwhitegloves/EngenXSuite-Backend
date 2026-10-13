import { randomBytes } from 'node:crypto';
import { getBusyTimes } from '../integrations/google/calendar.js';
import { logger } from '../infra/logger.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { BookingPage } from '../models/bookingPage.model.js';
import { Contact } from '../models/contact.model.js';
import { Meeting } from '../models/meeting.model.js';
import { MeetingType } from '../models/meetingType.model.js';
import { User } from '../models/user.model.js';
import { UserGoogleConnection } from '../models/userGoogleConnection.model.js';
import { loadRequestUser } from './auth.service.js';
import { getGoogleAccessToken } from './googleConnection.service.js';
import { closeMeeting, createMeeting } from './meetings.service.js';
import { listMeetingTypes } from './meetingTypes.service.js';
import { notify } from './notifications.service.js';

// A person's public booking page: a customer picks a kind of meeting and a free time, and the
// meeting is planned in that person's name (and, when connected, in their Google Calendar).
//
// A time is free when it lies inside the hours the person set (India time), not sooner than
// two hours from now, not further ahead than the page allows, and it does not touch a meeting
// of the CRM or a busy time of their Google Calendar, with the buffer kept on both sides.
// The public sees only free times: never what the person is busy with.

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const INDIA_OFFSET = 330 * MINUTE;
const EARLIEST_AHEAD = 120 * MINUTE;
// Monday to Friday, 10:00 to 18:00: what a new page starts with.
const STARTING_HOURS = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  startMinute: 600,
  endMinute: 1080,
}));

const slugOf = (name) =>
  `${
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30) || 'meet'
  }-${randomBytes(4).toString('hex')}`;

function toView(page, types) {
  return {
    slug: page.slug,
    isActive: page.isActive,
    intro: page.intro ?? '',
    meetingTypeIds: page.meetingTypeIds.map(String),
    availability: page.availability,
    bufferMinutes: page.bufferMinutes,
    maxDaysAhead: page.maxDaysAhead,
    // The kinds of meeting that may be offered (marked "bookable" in Settings).
    bookableTypes: types.filter((type) => type.isActive && type.isBookable),
  };
}

/** My booking page; made (switched off) the first time I look at it. */
export async function getMyBookingPage(actor) {
  const types = await listMeetingTypes();
  let page = await BookingPage.findOne({ userId: actor._id }).lean();
  if (!page) {
    const bookable = types.filter((type) => type.isActive && type.isBookable);
    // Two requests at the same moment: the second one finds the page the first one made.
    await BookingPage.create({
      userId: actor._id,
      slug: slugOf(actor.name),
      availability: STARTING_HOURS,
      meetingTypeIds: bookable.map((type) => type.id),
    }).catch((error) => {
      if (error?.code !== 11000) throw error;
    });
    page = await BookingPage.findOne({ userId: actor._id }).lean();
  }
  return toView(page, types);
}

/**
 * @param {{ isActive?: boolean, intro?: string, meetingTypeIds?: string[],
 *           availability?: { weekday: number, startMinute: number, endMinute: number }[],
 *           bufferMinutes?: number, maxDaysAhead?: number }} changes  Validated
 */
export async function updateMyBookingPage(actor, changes) {
  await getMyBookingPage(actor);
  if (changes.meetingTypeIds) {
    const bookable = await MeetingType.countDocuments({
      _id: { $in: changes.meetingTypeIds },
      isActive: true,
      isBookable: true,
    });
    if (bookable !== new Set(changes.meetingTypeIds).size) {
      throw badRequest('Choose meeting types that are marked as bookable in Settings.', [
        { field: 'meetingTypeIds' },
      ]);
    }
  }
  await BookingPage.updateOne({ userId: actor._id }, { $set: changes });
  return getMyBookingPage(actor);
}

/** A page that is switched on, with its owner and the kinds of meeting it offers. */
async function loadPublicPage(slug) {
  const page = await BookingPage.findOne({ slug, isActive: true }).lean();
  const owner = page && (await User.findOne({ _id: page.userId, status: 'active' }).lean());
  if (!owner) throw notFound('This booking page does not exist, or it is switched off.');
  const types = await MeetingType.find({
    _id: { $in: page.meetingTypeIds },
    isActive: true,
    isBookable: true,
  })
    .sort({ order: 1 })
    .lean();
  return { page, owner, types };
}

/** What a customer sees before choosing a time. Nothing about the person's calendar. */
export async function getPublicBookingPage(slug) {
  const { page, owner, types } = await loadPublicPage(slug);
  return {
    ownerName: owner.name,
    intro: page.intro ?? '',
    maxDaysAhead: page.maxDaysAhead,
    types: types.map((type) => ({
      id: String(type._id),
      name: type.name,
      mode: type.mode,
      durationMinutes: type.durationMinutes,
    })),
  };
}

/** When the owner is busy between two moments: CRM meetings, and Google Calendar when connected. */
async function busyTimes(ownerId, from, to) {
  const meetings = await Meeting.find({
    status: 'scheduled',
    $or: [{ organizerId: ownerId }, { internalAttendeeIds: ownerId }],
    startAt: { $lt: to },
    endAt: { $gt: from },
  })
    .select('startAt endAt')
    .lean();
  const busy = meetings.map((meeting) => ({ from: meeting.startAt, to: meeting.endAt }));
  if (await UserGoogleConnection.exists({ userId: ownerId, status: 'connected' })) {
    try {
      const token = await getGoogleAccessToken(ownerId);
      busy.push(...(await getBusyTimes(token, { from, to })));
    } catch (error) {
      // Google is away: the CRM's own meetings still count.
      logger.warn({ err: error, userId: String(ownerId) }, 'Busy times were not read from Google');
    }
  }
  return busy;
}

/** The free start times of one India day, for one kind of meeting. */
async function freeSlots(page, type, day, now) {
  const dayStart = new Date(`${day}T00:00:00+05:30`);
  if (Number.isNaN(dayStart.getTime())) throw badRequest('Give the day as YYYY-MM-DD.');
  const weekday = new Date(dayStart.getTime() + INDIA_OFFSET).getUTCDay();
  const length = type.durationMinutes * MINUTE;
  const buffer = page.bufferMinutes * MINUTE;
  const earliest = now.getTime() + EARLIEST_AHEAD;
  const latest = now.getTime() + page.maxDaysAhead * DAY;

  const candidates = [];
  for (const hours of page.availability.filter((item) => item.weekday === weekday)) {
    for (
      let start = dayStart.getTime() + hours.startMinute * MINUTE;
      start + length <= dayStart.getTime() + hours.endMinute * MINUTE;
      start += length
    ) {
      if (start >= earliest && start <= latest) candidates.push(start);
    }
  }
  if (candidates.length === 0) return [];
  const busy = await busyTimes(
    page.userId,
    new Date(dayStart.getTime() - buffer),
    new Date(dayStart.getTime() + DAY + buffer),
  );
  return candidates
    .filter((start) =>
      busy.every((item) => start + length + buffer <= +item.from || start - buffer >= +item.to),
    )
    .sort((a, b) => a - b)
    .map((start) => new Date(start));
}

/**
 * The free times of one day.
 * @param {{ typeId: string, date: string }} query  Validated; date as YYYY-MM-DD (India)
 * @param {Date} [now]  Only tests pass it
 */
export async function getFreeSlots(slug, { typeId, date }, now = new Date()) {
  const { page, types } = await loadPublicPage(slug);
  const type = types.find((item) => String(item._id) === typeId);
  if (!type) throw notFound('This kind of meeting is not offered here.');
  return { date, slots: await freeSlots(page, type, date, now) };
}

/**
 * A customer books a time. The meeting is planned in the owner's name; a person who is in the
 * CRM already (by their email) is linked to their company, anyone else is a guest by email.
 * @param {{ typeId: string, startAt: Date, name: string, email: string, company?: string,
 *           phone?: string, note?: string }} booking  Validated
 * @param {Date} [now]  Only tests pass it
 */
export async function bookSlot(slug, booking, now = new Date()) {
  const { page, owner, types } = await loadPublicPage(slug);
  const type = types.find((item) => String(item._id) === booking.typeId);
  if (!type) throw notFound('This kind of meeting is not offered here.');
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
    booking.startAt,
  );
  const free = await freeSlots(page, type, day, now);
  if (!free.some((slot) => +slot === +booking.startAt)) {
    throw conflict('This time is no longer free. Please choose another one.');
  }

  const actor = await loadRequestUser(owner._id);
  const endAt = new Date(booking.startAt.getTime() + type.durationMinutes * MINUTE);
  const plan = {
    title: `${type.name} with ${booking.name}`,
    mode: type.mode,
    typeId: String(type._id),
    startAt: booking.startAt,
    endAt,
    agenda: [
      `Booked on the booking page by ${booking.name} (${booking.email}).`,
      booking.company && `Company: ${booking.company}`,
      booking.phone && `Phone: ${booking.phone}`,
      booking.note && `Note: ${booking.note}`,
    ]
      .filter(Boolean)
      .join('\n'),
  };
  const guest = { extraGuests: [{ email: booking.email, name: booking.name }] };
  const contact = await Contact.findOne({ email: booking.email, deletedAt: null }).lean();
  const context = { bookedVia: 'booking_page' };
  let meeting;
  try {
    meeting = contact
      ? await createMeeting(
          actor,
          { ...plan, accountId: String(contact.accountId), contactIds: [String(contact._id)] },
          context,
        )
      : await createMeeting(actor, { ...plan, ...guest }, context);
  } catch (error) {
    // A person of a company the owner may not see: planned as a plain guest instead.
    if (!contact || error?.status !== 404) throw error;
    meeting = await createMeeting(actor, { ...plan, ...guest }, context);
  }

  // Two customers at the same moment: the one whose meeting was made second gives way.
  const rivals = await Meeting.find({
    status: 'scheduled',
    organizerId: owner._id,
    startAt: { $lt: endAt },
    endAt: { $gt: booking.startAt },
  })
    .sort({ createdAt: 1, _id: 1 })
    .select('_id')
    .lean();
  if (rivals.length > 1 && String(rivals[0]._id) !== meeting.id) {
    await closeMeeting(actor, meeting.id, { status: 'cancelled', tellGuests: false });
    throw conflict('This time is no longer free. Please choose another one.');
  }

  await notify({
    userId: owner._id,
    type: 'meeting_booked',
    title: `${booking.name} booked a meeting with you`,
    body: `${type.name}, ${new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Kolkata',
    }).format(booking.startAt)}`,
    link: `/calendar?meeting=${meeting.id}`,
    dedupeKey: `meeting-booked:${meeting.id}`,
  });
  return {
    ownerName: owner.name,
    typeName: type.name,
    mode: type.mode,
    startAt: booking.startAt,
    endAt,
    meetLink: meeting.meetLink,
  };
}
