import mongoose from 'mongoose';
import { MEETING_MODES } from './meeting.model.js';

// The kinds of meeting the team plans, managed in Settings → Meeting types: a name, how it is
// held (online, in person, plant visit) and how long it usually takes.
// Written only by services/meetingTypes.service.js. Schema only: no methods (decision 0005).

const meetingTypeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    mode: { type: String, enum: MEETING_MODES, required: true },
    durationMinutes: { type: Number, required: true, min: 15, max: 480 },
    // Offered to customers on the public booking pages.
    isBookable: { type: Boolean, required: true, default: false },
    isActive: { type: Boolean, required: true, default: true },
    order: { type: Number, required: true, default: 0 },
  },
  { timestamps: true, versionKey: false, collection: 'meeting_types' },
);
meetingTypeSchema.index({ name: 1 }, { unique: true });

export const MeetingType =
  mongoose.models.MeetingType ?? mongoose.model('MeetingType', meetingTypeSchema);
