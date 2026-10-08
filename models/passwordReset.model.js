import mongoose from 'mongoose';

// One "forgot password" request. Only a hash of the token is stored: someone who can read the
// database still cannot use the link. Schema only: no methods (decision 0005).

const passwordResetSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // SHA-256 of the token that was emailed.
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// MongoDB removes a request by itself one day after it expired.
passwordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

export const PasswordReset =
  mongoose.models.PasswordReset ??
  mongoose.model('PasswordReset', passwordResetSchema, 'password_resets');
