import mongoose from 'mongoose';

// One person's permission for the CRM to use their Gmail and Calendar. At most one per user.
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
    // The Google account that gave the permission: always the user's own company address.
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
    connectedAt: { type: Date, required: true },
    // Where the mailbox and calendar sync stand (filled by the sync jobs).
    gmail: {
      historyId: { type: String },
      watchExpiresAt: { type: Date },
      lastSyncAt: { type: Date },
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
