import mongoose from 'mongoose';

// One phone call through Plivo (Master Prompt Section 14).
// Written only by services/calls.service.js. Schema only: no methods (decision 0005).

const { ObjectId } = mongoose.Schema.Types;

export const CALL_DIRECTIONS = ['inbound', 'outbound'];
export const CALL_STATUSES = [
  'initiated', // asked for; Plivo is ringing the agent
  'ringing', // inbound: the agent's phone is ringing
  'in_progress', // both sides are talking
  'completed', // they talked
  'missed', // inbound, nobody picked up
  'busy',
  'no_answer',
  'failed',
];
// What the agent says came of the call.
export const CALL_OUTCOMES = [
  'connected',
  'no_answer',
  'callback_requested',
  'not_interested',
  'wrong_number',
];

const callSchema = new mongoose.Schema(
  {
    // Plivo's id of the call. Empty for the first moments of a click-to-call.
    plivoCallUuid: { type: String },
    direction: { type: String, enum: CALL_DIRECTIONS, required: true },
    // In the international form (+91…). Kept as they were, for matching and history.
    fromNumber: { type: String, required: true },
    toNumber: { type: String, required: true },
    status: { type: String, enum: CALL_STATUSES, required: true, default: 'initiated' },
    startedAt: { type: Date },
    answeredAt: { type: Date },
    endedAt: { type: Date },
    // How long the two sides talked.
    durationSec: { type: Number, min: 0 },
    // What Plivo charged, in the currency of the Plivo account.
    cost: { type: Number },
    hangupCause: { type: String, maxlength: 100 },
    // The agent: who made the call, or whose phone an inbound call was sent to.
    userId: { type: ObjectId, ref: 'User' },
    // Who the call was with. Found by the phone number; can be corrected by the user.
    contactId: { type: ObjectId, ref: 'Contact' },
    accountId: { type: ObjectId, ref: 'Account' },
    opportunityId: { type: ObjectId, ref: 'Opportunity' },
    // The S3 address of the recording (private bucket). Sensitive.
    recordingUrl: { type: String },
    // True when the "this call is recorded" announcement was part of the call.
    recordingConsentPlayed: { type: Boolean, required: true, default: false },
    outcome: { type: String, enum: CALL_OUTCOMES },
    // For the AI analysis of a later phase.
    analysisStatus: {
      type: String,
      enum: ['none', 'queued', 'done', 'failed', 'skipped_short', 'skipped_cap'],
      required: true,
      default: 'none',
    },
    // What Plivo told us about the two sides of the call, as received (small display values).
    plivo: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true, versionKey: false },
);

callSchema.index(
  { plivoCallUuid: 1 },
  { unique: true, partialFilterExpression: { plivoCallUuid: { $exists: true } } },
);
callSchema.index({ userId: 1, startedAt: -1 });
callSchema.index({ contactId: 1 });
callSchema.index({ accountId: 1 });
callSchema.index({ opportunityId: 1 });
callSchema.index({ direction: 1, status: 1, startedAt: -1 });
callSchema.index({ fromNumber: 1 });
callSchema.index({ toNumber: 1 });

export const Call = mongoose.models.Call ?? mongoose.model('Call', callSchema);
