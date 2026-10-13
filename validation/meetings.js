import { z } from 'zod';
import { MEETING_MODES } from '../models/meeting.model.js';
import { email, objectId } from './common.js';

const moment = z.coerce.date();
const DAY_MS = 24 * 60 * 60 * 1000;

// The calendar asks for a span of days (at most about two months); a lead or a company asks
// for its own meetings.
export const listMeetingsQuery = z
  .object({
    from: moment.optional(),
    to: moment.optional(),
    mine: z.enum(['true', 'false']).optional(),
    opportunityId: objectId.optional(),
    accountId: objectId.optional(),
  })
  .refine((query) => query.opportunityId || query.accountId || (query.from && query.to), {
    message: 'Give the days to show (from and to)',
    path: ['from'],
  })
  .refine((query) => !query.from || !query.to || query.to - query.from <= 62 * DAY_MS, {
    message: 'Ask for at most two months at a time',
    path: ['to'],
  })
  .transform((query) => ({ ...query, mine: query.mine === 'true' }));

const plan = {
  title: z.string().trim().min(1, 'Give the meeting a title').max(200),
  // The kind from Settings → Meeting types (the screen copies its mode and length).
  typeId: objectId.optional(),
  mode: z.enum(MEETING_MODES),
  startAt: moment,
  endAt: moment,
  location: z.string().trim().max(300).optional(),
  agenda: z.string().trim().max(4000).optional(),
  contactIds: z.array(objectId).max(20).optional(),
  internalAttendeeIds: z.array(objectId).max(20).optional(),
  // Guests who are not people of the company in the CRM: anyone, by email.
  extraGuests: z
    .array(z.object({ email, name: z.string().trim().max(200).optional() }))
    .max(30)
    .optional(),
  // What the guests may do with the event in Google Calendar.
  guestOptions: z
    .object({
      canInviteOthers: z.boolean().optional(),
      canModify: z.boolean().optional(),
      canSeeGuests: z.boolean().optional(),
    })
    .optional(),
  // false: Google does not mail the invitation (or the change) to the guests.
  tellGuests: z.boolean().optional(),
};

export const createMeetingBody = z
  .object({ ...plan, opportunityId: objectId.optional(), accountId: objectId.optional() })
  .refine((body) => body.endAt > body.startAt, {
    message: 'The end must be after the start',
    path: ['endAt'],
  })
  .refine((body) => body.endAt - body.startAt <= DAY_MS, {
    message: 'A meeting can be at most one day long',
    path: ['endAt'],
  });

export const updateMeetingBody = z
  .object({
    ...plan,
    title: plan.title.optional(),
    mode: plan.mode.optional(),
    startAt: moment.optional(),
    endAt: moment.optional(),
    notes: z.string().trim().max(20000).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });

export const closeMeetingBody = z.object({
  status: z.enum(['completed', 'no_show', 'cancelled']),
  // What was said and decided (for a meeting that was held), or why it did not take place.
  notes: z.string().trim().max(20000).optional(),
  tellGuests: z.boolean().optional(),
});

// A task the AI proposed after a meeting: accepted (it becomes a real task) or rejected.
export const decideTaskBody = z.object({
  index: z.number().int().min(0).max(50),
  decision: z.enum(['accept', 'reject']),
});

// A voice note of the meeting, by its own address.
export const transcribeBody = z.object({ url: z.string().url().max(1000) });

// ── Meeting types (Settings)
const typeFields = {
  name: z.string().trim().min(1, 'Give it a name').max(80),
  mode: z.enum(MEETING_MODES),
  durationMinutes: z.number().int().min(15).max(480),
  isBookable: z.boolean().optional(),
  isActive: z.boolean().optional(),
};
export const createMeetingTypeBody = z.object(typeFields);
export const updateMeetingTypeBody = z
  .object({
    name: typeFields.name.optional(),
    mode: typeFields.mode.optional(),
    durationMinutes: typeFields.durationMinutes.optional(),
    isBookable: z.boolean().optional(),
    isActive: z.boolean().optional(),
    order: z.number().int().min(0).max(1000).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });

// ── My booking page
export const updateBookingPageBody = z
  .object({
    isActive: z.boolean().optional(),
    intro: z.string().trim().max(500).optional(),
    meetingTypeIds: z.array(objectId).max(20).optional(),
    availability: z
      .array(
        z
          .object({
            weekday: z.number().int().min(0).max(6),
            startMinute: z.number().int().min(0).max(1439),
            endMinute: z.number().int().min(1).max(1440),
          })
          .refine((hours) => hours.endMinute > hours.startMinute, {
            message: 'The end must be after the start',
          }),
      )
      .max(21)
      .optional(),
    bufferMinutes: z.number().int().min(0).max(120).optional(),
    maxDaysAhead: z.number().int().min(1).max(90).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });

// ── The public booking page
export const bookingSlugParams = z.object({ slug: z.string().trim().min(3).max(60) });
export const slotsQuery = z.object({
  typeId: objectId,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Give the day as YYYY-MM-DD'),
});
export const bookSlotBody = z.object({
  typeId: objectId,
  startAt: moment,
  name: z.string().trim().min(2, 'Give your name').max(120),
  email,
  company: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(30).optional(),
  note: z.string().trim().max(1000).optional(),
});
