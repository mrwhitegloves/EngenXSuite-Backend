import mongoose from 'mongoose';

// The one timeline (Master Prompt Sections 13 and 49). Every call, email, WhatsApp message,
// meeting, note, task event, document event, stage change and AI event is one row here.
// Written only by recordActivity() in services/activities.service.js.
// Schema only: no methods (decision 0005).

const { ObjectId } = mongoose.Schema.Types;

export const ACTIVITY_TYPES = [
  'CALL',
  'EMAIL',
  'WHATSAPP',
  'MEETING',
  'NOTE',
  'TASK',
  'DOCUMENT',
  'SYSTEM',
  'VOICE_NOTE',
];
export const ACTIVITY_DIRECTIONS = ['inbound', 'outbound', 'internal'];

const activitySchema = new mongoose.Schema(
  {
    type: { type: String, enum: ACTIVITY_TYPES, required: true },
    // What exactly happened, for example "stage_changed", "task_completed", "lead_created".
    subtype: { type: String, trim: true, maxlength: 60 },
    direction: { type: String, enum: ACTIVITY_DIRECTIONS },

    // What the entry belongs to. At least one of account, contact and lead is set.
    accountId: { type: ObjectId, ref: 'Account' },
    plantId: { type: ObjectId, ref: 'Plant' },
    contactId: { type: ObjectId, ref: 'Contact' },
    opportunityId: { type: ObjectId, ref: 'Opportunity' },
    // Who did it. Empty for something the system did by itself.
    userId: { type: ObjectId, ref: 'User' },

    // When it happened, not when it was saved.
    occurredAt: { type: Date, required: true },
    // The one line the timeline shows.
    title: { type: String, required: true, trim: true, maxlength: 300 },
    // The text of a note, or a short excerpt of a message.
    content: { type: String, maxlength: 5000 },
    // A copy of the channel's status for display, for example "missed" or "delivered".
    status: { type: String, maxlength: 40 },
    // The detail record behind the entry (a task, a call, a stage_history row …).
    refCollection: { type: String, maxlength: 60 },
    refId: { type: ObjectId },
    // Small values for display only (names of the old and new stage, a call's length).
    metadata: { type: mongoose.Schema.Types.Mixed },
    aiSummary: { type: String, maxlength: 2000 },
    // Set when the text of a note was changed after it was written.
    editedAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
);

activitySchema.index({ accountId: 1, occurredAt: -1 });
activitySchema.index({ opportunityId: 1, occurredAt: -1 });
activitySchema.index({ contactId: 1, occurredAt: -1 });
activitySchema.index({ userId: 1, occurredAt: -1 });
activitySchema.index({ type: 1, occurredAt: -1 });
// The same event of the same record is written once, however often its writer runs.
activitySchema.index(
  { refCollection: 1, refId: 1, subtype: 1 },
  { unique: true, partialFilterExpression: { refId: { $exists: true } } },
);

export const Activity =
  mongoose.models.Activity ?? mongoose.model('Activity', activitySchema, 'activities');
