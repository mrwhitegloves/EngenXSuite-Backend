import mongoose from 'mongoose';

// A bulk sending: one mail or one WhatsApp template to everyone in a bundle, one after the
// other with a gap, and a row for every person that says what happened and why.
// Written only by services/campaigns.service.js. Schema only: no methods (decision 0005).

const { ObjectId } = mongoose.Schema.Types;

export const CAMPAIGN_CHANNELS = ['email', 'whatsapp'];
// draft: made, not started. running: sending. paused: stopped by a person or by a problem
// that concerns everyone (mailbox not connected, AI limit). finished: everyone was handled.
export const CAMPAIGN_STATUSES = ['draft', 'running', 'paused', 'finished', 'cancelled'];
// pending: still to do. sending: being sent this moment. sent / failed / skipped: done.
export const RECIPIENT_STATUSES = ['pending', 'sending', 'sent', 'failed', 'skipped'];

const campaignSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    channel: { type: String, enum: CAMPAIGN_CHANNELS, required: true },
    // Who sends: a mail goes out from THEIR own Gmail.
    createdBy: { type: ObjectId, ref: 'User', required: true },
    status: { type: String, enum: CAMPAIGN_STATUSES, required: true, default: 'draft' },
    // Why it is paused, in plain words; empty otherwise.
    pauseReason: { type: String, maxlength: 300 },
    // Seconds between one person and the next.
    gapSeconds: { type: Number, required: true, min: 5, max: 3600 },
    // The bundle it was made from (kept by name too: the bundle may be deleted later).
    bundleId: { type: ObjectId, ref: 'Bundle' },
    bundleName: { type: String, maxlength: 120 },

    // ── Mail
    // ai: the AI writes each mail for its reader. fixed: the same text for everyone.
    writeMode: { type: String, enum: ['ai', 'fixed'] },
    // What the mail is about (for the AI), or the text itself (fixed; {{name}}, {{company}}).
    brief: { type: String, maxlength: 4000 },
    subject: { type: String, maxlength: 300 },
    body: { type: String, maxlength: 8000 },
    // A reminder goes to someone we wrote to only after this many days without an answer.
    minDaysBeforeReminder: { type: Number, min: 0, max: 60, default: 3 },
    attachments: {
      type: [{ _id: false, url: String, filename: String, mimeType: String }],
      default: [],
    },

    // ── WhatsApp: an approved template, with the texts for its {{1}}, {{2}} … places.
    templateName: { type: String, maxlength: 120 },
    templateLanguage: { type: String, maxlength: 20 },
    templateParams: { type: [String], default: [] },

    startedAt: { type: Date },
    finishedAt: { type: Date },
    // When the next person is due; the sweep job starts a sending that fell asleep.
    nextStepAt: { type: Date },
  },
  { timestamps: true, versionKey: false, collection: 'campaigns' },
);
campaignSchema.index({ createdBy: 1, createdAt: -1 });
campaignSchema.index({ status: 1, nextStepAt: 1 });

const campaignRecipientSchema = new mongoose.Schema(
  {
    campaignId: { type: ObjectId, ref: 'Campaign', required: true },
    order: { type: Number, required: true },
    kind: { type: String, enum: ['person', 'company'], required: true },
    contactId: { type: ObjectId, ref: 'Contact' },
    accountId: { type: ObjectId, ref: 'Account' },
    opportunityId: { type: ObjectId, ref: 'Opportunity' },
    // As they were when the sending was made.
    name: { type: String, maxlength: 200 },
    company: { type: String, maxlength: 200 },
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String },
    status: { type: String, enum: RECIPIENT_STATUSES, required: true, default: 'pending' },
    // What was done: a first mail, a reminder inside an earlier conversation, or a template.
    action: { type: String, enum: ['new', 'reminder', 'template'] },
    // Why it failed or was skipped, in words anyone understands.
    reason: { type: String, maxlength: 400 },
    // What went out.
    subject: { type: String, maxlength: 300 },
    body: { type: String, maxlength: 8000 },
    threadId: { type: ObjectId, ref: 'EmailThread' },
    processedAt: { type: Date },
  },
  { timestamps: true, versionKey: false, collection: 'campaign_recipients' },
);
campaignRecipientSchema.index({ campaignId: 1, status: 1, order: 1 });
campaignRecipientSchema.index({ campaignId: 1, processedAt: -1 });

export const Campaign = mongoose.models.Campaign ?? mongoose.model('Campaign', campaignSchema);
export const CampaignRecipient =
  mongoose.models.CampaignRecipient ?? mongoose.model('CampaignRecipient', campaignRecipientSchema);
