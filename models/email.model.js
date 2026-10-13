import mongoose from 'mongoose';

// Customer mail kept in the CRM: a conversation (thread) and its messages, taken from the
// mailbox of the person who connected it. ONLY mail with a person who is in the CRM is kept:
// the rest of a mailbox is never stored (not even looked into: see emailSync.service.js).
// Written only by services/emailSync.service.js and services/emails.service.js.
// Schema only: no methods (decision 0005).

const { ObjectId } = mongoose.Schema.Types;

// What the AI says a customer's mail is (ai/tasks/classifyEmail.js).
export const EMAIL_CATEGORIES = [
  'enquiry',
  'quotation_request',
  'follow_up',
  'meeting_request',
  'complaint',
  'information',
  'other',
];

export const EMAIL_SENTIMENTS = ['positive', 'neutral', 'negative'];

const emailThreadSchema = new mongoose.Schema(
  {
    // Whose mailbox it is in. The conversation as Gmail knows it.
    userId: { type: ObjectId, ref: 'User', required: true },
    gmailThreadId: { type: String, required: true },
    subject: { type: String, trim: true, maxlength: 500 },
    // Every address of the conversation that is not the mailbox owner's.
    participants: { type: [String], default: [] },
    snippet: { type: String, maxlength: 300 },
    messageCount: { type: Number, required: true, default: 0 },
    lastMessageAt: { type: Date, required: true },
    // The last message came from the customer: somebody should answer.
    lastDirection: { type: String, enum: ['inbound', 'outbound'] },
    // Who it is with. Found by the email address; left empty rather than guessed.
    contactId: { type: ObjectId, ref: 'Contact' },
    accountId: { type: ObjectId, ref: 'Account' },
    opportunityId: { type: ObjectId, ref: 'Opportunity' },
    // The AI's reading of the newest customer message.
    ai: {
      category: { type: String, enum: EMAIL_CATEGORIES },
      needsReply: { type: Boolean },
      summary: { type: String, maxlength: 600 },
      suggestedAction: { type: String, maxlength: 300 },
      // How the customer sounds in their newest mail.
      sentiment: { type: String, enum: EMAIL_SENTIMENTS },
      aiRunId: { type: ObjectId, ref: 'AiRun' },
      forMessageId: { type: ObjectId },
      at: { type: Date },
    },
  },
  { timestamps: true, versionKey: false, collection: 'email_threads' },
);
emailThreadSchema.index({ userId: 1, gmailThreadId: 1 }, { unique: true });
emailThreadSchema.index({ userId: 1, lastMessageAt: -1 });
emailThreadSchema.index({ accountId: 1, lastMessageAt: -1 });
emailThreadSchema.index({ opportunityId: 1 });

const emailSchema = new mongoose.Schema(
  {
    threadId: { type: ObjectId, ref: 'EmailThread', required: true },
    userId: { type: ObjectId, ref: 'User', required: true },
    gmailMessageId: { type: String, required: true },
    // inbound: the customer wrote. outbound: the mailbox owner wrote.
    direction: { type: String, enum: ['inbound', 'outbound'], required: true },
    from: { type: String, lowercase: true },
    fromName: { type: String, maxlength: 200 },
    to: { type: [String], default: [] },
    cc: { type: [String], default: [] },
    subject: { type: String, maxlength: 500 },
    sentAt: { type: Date, required: true },
    snippet: { type: String, maxlength: 300 },
    // The readable text (plain), cut at 50,000 characters.
    text: { type: String },
    // The files of the mail. Each is copied into our private bucket (emailFiles.service.js);
    // url is the address of that copy, and is missing when the file was too large to copy.
    attachments: {
      type: [{ _id: false, filename: String, mimeType: String, size: Number, url: String }],
      default: [],
    },
    // Set once the files of a mail kept earlier (names only) were looked for in Gmail again.
    filesCheckedAt: { type: Date },
    // The message's own id header, needed to answer inside the same conversation.
    messageIdHeader: { type: String },
    references: { type: String },
  },
  { timestamps: true, versionKey: false, collection: 'emails' },
);
// The same Gmail message synced twice is stored once.
emailSchema.index({ userId: 1, gmailMessageId: 1 }, { unique: true });
emailSchema.index({ threadId: 1, sentAt: 1 });

export const EmailThread =
  mongoose.models.EmailThread ?? mongoose.model('EmailThread', emailThreadSchema);
export const Email = mongoose.models.Email ?? mongoose.model('Email', emailSchema);
