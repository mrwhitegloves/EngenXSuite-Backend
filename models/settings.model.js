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
