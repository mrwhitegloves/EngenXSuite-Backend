import mongoose from 'mongoose';

// A meeting recorder (the Chrome extension on one laptop) connected to one user.
// It signs in with its own token, never with the user's password. Only a hash of the token is
// kept, so a copy of the database cannot be used to sign in. A pairing code (shown in the CRM,
// typed into the extension once) is a row without a token yet.
// Written only by services/recorderDevices.service.js. Schema only: no methods (decision 0005).

const { ObjectId } = mongoose.Schema.Types;

const recorderDeviceSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true },
    // What the extension calls the laptop (for example "Chrome on Windows").
    name: { type: String, trim: true, maxlength: 100 },
    // SHA-256 of the pairing code while it waits to be used; removed once it is used.
    pairingCodeHash: { type: String },
    pairingExpiresAt: { type: Date },
    // SHA-256 of the token the extension holds.
    tokenHash: { type: String },
    connectedAt: { type: Date },
    lastUsedAt: { type: Date },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'recorder_devices' },
);
recorderDeviceSchema.index(
  { tokenHash: 1 },
  { unique: true, partialFilterExpression: { tokenHash: { $type: 'string' } } },
);
recorderDeviceSchema.index(
  { pairingCodeHash: 1 },
  { unique: true, partialFilterExpression: { pairingCodeHash: { $type: 'string' } } },
);
recorderDeviceSchema.index({ userId: 1, createdAt: -1 });

export const RecorderDevice =
  mongoose.models.RecorderDevice ?? mongoose.model('RecorderDevice', recorderDeviceSchema);
