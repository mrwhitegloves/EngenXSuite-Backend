import mongoose from 'mongoose';

// One document (key "app") with product-wide settings. More sections are added by the phase that
// needs them (company details, AI limits, call settings, lead assignment).
// Schema only: no methods (decision 0005).

// How a lead that arrives by itself gets its owner (services/leadAssignment.service.js).
export const ASSIGNMENT_MODES = [
  'off',
  'round_robin_all',
  'round_robin_selected',
  'fixed',
  'least_open',
];

const settingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'app' },
    branding: {
      // The product name shown everywhere in the UI, emails, PDFs and prompts (decision 0001).
      productName: { type: String, required: true, trim: true, maxlength: 60 },
      // The company name printed on commercial documents.
      companyName: { type: String, required: true, trim: true, maxlength: 120 },
      logoLightFileId: { type: mongoose.Schema.Types.ObjectId, default: null },
      logoDarkFileId: { type: mongoose.Schema.Types.ObjectId, default: null },
      faviconFileId: { type: mongoose.Schema.Types.ObjectId, default: null },
    },
    calls: {
      // Record calls (where the law allows it). Off: no call is recorded.
      recordingEnabled: { type: Boolean, default: false },
      // Say the announcement below before a recorded call is joined. Off: the call is recorded
      // without telling the other side (founder decision 2026-10-12; the legal risk is theirs).
      announcementEnabled: { type: Boolean, default: true },
      // Said to the other side before a recorded call is joined.
      consentText: {
        type: String,
        trim: true,
        maxlength: 300,
        default: 'This call may be recorded for quality and training.',
      },
      // Who gets an inbound call from a number nobody knows, or whose owner has no phone.
      defaultInboundUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    },
    ai: {
      // The most the AI may cost in one month, in paise. Reached: AI features pause.
      monthlyCapPaise: { type: Number, min: 0 },
      // How many AI runs one person may start in a day.
      dailyRunsPerUser: { type: Number, min: 0 },
      // The people who manage the settings are warned when this much of the budget is used.
      alertPercent: { type: Number, min: 1, max: 99 },
      // Refresh an insight by itself after something happened on its record.
      autoRefresh: { type: Boolean },
      // The audio-to-text model (an id from ai/config.js).
      transcribeModel: { type: String },
      // Per class of work (fast, balanced, strong): { model, fallback }, ids from ai/config.js.
      models: { type: mongoose.Schema.Types.Mixed },
    },
    backups: {
      // When backups older than the keep time are deleted, India time, "HH:mm".
      deleteTime: { type: String, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
      // How many minutes before that the people who manage the settings are told. 0 = at that moment.
      notifyMinutesBefore: { type: Number, min: 0 },
      // The India day ("2026-10-12") the clean-up last ran for, and the day it last warned for.
      lastCleanupDay: { type: String },
      lastWarningDay: { type: String },
    },
    leadAssignment: {
      mode: { type: String, enum: ASSIGNMENT_MODES, default: 'round_robin_all' },
      // The people of "round robin: chosen people" and "fewest open leads".
      userIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], default: [] },
      // The person of "always the same person".
      fixedUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      // People who get no new lead for now (on leave).
      awayUserIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], default: [] },
      // Who got the last lead: the next one goes to the person after them.
      lastAssignedUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    },
  },
  { timestamps: true },
);

export const Settings = mongoose.models.Settings ?? mongoose.model('Settings', settingsSchema);
