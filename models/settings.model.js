import mongoose from 'mongoose';

// One document (key "app") with product-wide settings. More sections are added by the phase that
// needs them (company details, AI limits, call settings, lead assignment).
// Schema only: no methods (decision 0005).

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
  },
  { timestamps: true },
);

export const Settings = mongoose.models.Settings ?? mongoose.model('Settings', settingsSchema);
