import mongoose from 'mongoose';

// The company mailbox: the permission for the CRM to use ONE Gmail and Calendar for everyone
// (decision 0014). There is at most one document. `userId` is the id the mailbox's mail is
// stored under (the person who first connected it); `connectedBy` who connected it last.
// The tokens are kept sealed (lib/secretBox.js) and never leave the server.
// Written only by services/googleConnection.service.js. Schema only: no methods (decision 0005).

const { ObjectId } = mongoose.Schema.Types;

export const GOOGLE_CONNECTION_STATUSES = [
  'connected',
  'needs_reconnect', // Google no longer accepts the token: the person has to connect again
];

const userGoogleConnectionSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true, unique: true },
    // The Google account that gave the permission: a company address (kunal@engenx.in).
    googleEmail: { type: String, required: true, lowercase: true, trim: true },
    scopes: { type: [String], default: [] },
    // Sealed. `select: false`: a query has to ask for them by name.
    refreshToken: { type: String, required: true, select: false },
    accessToken: { type: String, select: false },
    accessTokenExpiresAt: { type: Date },
    status: {
      type: String,
      enum: GOOGLE_CONNECTION_STATUSES,
      required: true,
      default: 'connected',
    },
    lastError: { type: String, maxlength: 300 },
    // The lines under every mail of the company mailbox (plain text).
    signature: { type: String, maxlength: 1000 },
    connectedAt: { type: Date, required: true },
    connectedBy: { type: ObjectId, ref: 'User' },
    // Where the mailbox and calendar sync stand (filled by the sync jobs).
    gmail: {
      historyId: { type: String },
      watchExpiresAt: { type: Date },
      lastSyncAt: { type: Date },
      // Set while a sync runs, so that two never read the same mailbox at once.
      syncStartedAt: { type: Date },
    },
    calendar: {
      syncToken: { type: String },
      lastSyncAt: { type: Date },
    },
  },
  { timestamps: true, versionKey: false, collection: 'user_google_connections' },
);

export const UserGoogleConnection =
  mongoose.models.UserGoogleConnection ??
  mongoose.model('UserGoogleConnection', userGoogleConnectionSchema);
