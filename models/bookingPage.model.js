import mongoose from 'mongoose';

// One person's public booking page: when customers may book a meeting with them, and which
// kinds of meeting. At most one per user; it is public only while it is switched on.
// Written only by services/bookingPages.service.js. Schema only: no methods (decision 0005).

const { ObjectId } = mongoose.Schema.Types;

const bookingPageSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true, unique: true },
    // The public address part: the person's name and a random part, so it cannot be guessed.
    slug: { type: String, required: true, unique: true },
    isActive: { type: Boolean, required: true, default: false },
    // A few words for the customer, above the times.
    intro: { type: String, maxlength: 500 },
    meetingTypeIds: { type: [ObjectId], ref: 'MeetingType', default: [] },
    // When the person takes meetings, in India time. weekday: 0 = Sunday … 6 = Saturday.
    availability: {
      type: [
        {
          _id: false,
          weekday: { type: Number, min: 0, max: 6, required: true },
          startMinute: { type: Number, min: 0, max: 1439, required: true },
          endMinute: { type: Number, min: 1, max: 1440, required: true },
        },
      ],
      default: [],
    },
    // Free time kept before and after every meeting.
    bufferMinutes: { type: Number, required: true, default: 15, min: 0, max: 120 },
    maxDaysAhead: { type: Number, required: true, default: 30, min: 1, max: 90 },
  },
  { timestamps: true, versionKey: false, collection: 'booking_pages' },
);

export const BookingPage =
  mongoose.models.BookingPage ?? mongoose.model('BookingPage', bookingPageSchema);
