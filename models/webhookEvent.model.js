import mongoose from 'mongoose';

// Every incoming webhook, stored before anything else happens (Master Prompt Section 51).
// It gives three things: the same event is never handled twice (the unique index below), an
// event survives a restart or a Redis outage (it is in the database, not only in a queue), and
// there is a record to look at when a provider says "we sent it".
// Schema only: no methods (decision 0005).

export const WEBHOOK_PROVIDERS = [
  'plivo',
  'whatsapp',
  'meta_leads',
  'google',
  'email_provider',
  'website',
];
export const WEBHOOK_STATUSES = ['received', 'queued', 'processed', 'failed', 'ignored'];

const webhookEventSchema = new mongoose.Schema(
  {
    provider: { type: String, required: true, enum: WEBHOOK_PROVIDERS },
    // The provider's own id of the event; when it sends none, a hash of the body.
    eventId: { type: String, required: true },
    // The body as received. Not kept for requests that failed the signature check.
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    signatureValid: { type: Boolean, required: true },
    status: { type: String, required: true, enum: WEBHOOK_STATUSES, default: 'received' },
    attempts: { type: Number, required: true, default: 0 },
    error: { type: String },
    processedAt: { type: Date },
    // MongoDB deletes the document by itself after this moment.
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false },
);

// The duplicate-key error of this index is how a repeated delivery is recognised.
webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });
webhookEventSchema.index({ status: 1, createdAt: 1 });
webhookEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const WebhookEvent =
  mongoose.models.WebhookEvent ??
  mongoose.model('WebhookEvent', webhookEventSchema, 'webhook_events');
