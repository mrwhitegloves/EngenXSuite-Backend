import mongoose from 'mongoose';

// One meeting or plant visit with a customer (Master Prompt Section 21).
// Written only by services/meetings.service.js and services/calendarSync.service.js.
// Schema only: no methods (decision 0005).

const { ObjectId } = mongoose.Schema.Types;

// online: a Google Meet call. physical: at an office. plant_visit: at the customer's plant.
export const MEETING_MODES = ['online', 'physical', 'plant_visit'];
export const MEETING_STATUSES = ['scheduled', 'completed', 'cancelled', 'no_show'];
// crm: planned here. google: found in the organizer's Google Calendar (with a CRM contact).
export const MEETING_SOURCES = ['crm', 'booking_page', 'google'];
// What a guest answered to the invitation (Google's words).
export const GUEST_RESPONSES = ['needsAction', 'accepted', 'declined', 'tentative'];

const meetingSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    mode: { type: String, enum: MEETING_MODES, required: true },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    location: { type: String, trim: true, maxlength: 300 },
    // What it is about (goes into the invitation).
    agenda: { type: String, maxlength: 4000 },
    // What was said and decided: filled in when the meeting is over.
    notes: { type: String, maxlength: 20000 },
    meetLink: { type: String, maxlength: 500 },
    // Whose meeting it is, and whose Google Calendar holds it.
    organizerId: { type: ObjectId, ref: 'User', required: true },
    internalAttendeeIds: { type: [ObjectId], ref: 'User', default: [] },
    // The guests from outside: people of the customer (with contactId) and anyone else by email.
    attendees: {
      type: [
        {
          _id: false,
          contactId: { type: ObjectId, ref: 'Contact' },
          email: { type: String, lowercase: true, trim: true },
          name: { type: String, maxlength: 200 },
          response: { type: String, enum: GUEST_RESPONSES, default: 'needsAction' },
        },
      ],
      default: [],
    },
    // What the guests may do with the event in Google Calendar (as in Google's own form).
    guestOptions: {
      canInviteOthers: { type: Boolean, default: true },
      canModify: { type: Boolean, default: false },
      canSeeGuests: { type: Boolean, default: true },
    },
    accountId: { type: ObjectId, ref: 'Account' },
    opportunityId: { type: ObjectId, ref: 'Opportunity' },
    status: { type: String, enum: MEETING_STATUSES, required: true, default: 'scheduled' },
    bookedVia: { type: String, enum: MEETING_SOURCES, required: true, default: 'crm' },
    // The event in the organizer's Google Calendar; empty when their calendar is not connected.
    googleEventId: { type: String },
    // Why the last change did not reach Google Calendar; empty when it did.
    googleSyncError: { type: String, maxlength: 300 },
    // Set once the people of our side were reminded; cleared when the time changes.
    reminderSentAt: { type: Date },
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true, versionKey: false, collection: 'meetings' },
);
meetingSchema.index({ organizerId: 1, startAt: 1 });
meetingSchema.index({ internalAttendeeIds: 1, startAt: 1 });
meetingSchema.index({ accountId: 1, startAt: -1 });
meetingSchema.index({ opportunityId: 1, startAt: -1 });
meetingSchema.index({ status: 1, startAt: 1 });
// One meeting for one event of one person's calendar.
meetingSchema.index(
  { organizerId: 1, googleEventId: 1 },
  { unique: true, partialFilterExpression: { googleEventId: { $type: 'string' } } },
);

export const Meeting = mongoose.models.Meeting ?? mongoose.model('Meeting', meetingSchema);
