import mongoose from 'mongoose';

// Everyone who may sign in. Users are never deleted, only deactivated.
// Schema only: no methods (decision 0005).

export const USER_STATUSES = ['invited', 'active', 'deactivated'];
export const THEMES = ['light', 'dark', 'system'];

const userSchema = new mongoose.Schema(
  {
    // The login email: used for email + password sign-in and matched for Google sign-in.
    // Always stored lowercase.
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    // Set on the first sign-in. Sparse: invited users do not have one yet.
    googleId: { type: String, unique: true, sparse: true },
    avatarUrl: { type: String },
    // bcrypt hash for email + password sign-in (decision 0009). `select: false` keeps it out of
    // every query unless a query asks for it by name, so it cannot leak into a response by accident.
    passwordHash: { type: String, select: false },
    // True for a new account or after someone else reset the password: the user must choose
    // their own password before doing anything else.
    mustChangePassword: { type: Boolean, required: true, default: false },
    passwordChangedAt: { type: Date },
    roleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Role', required: true, index: true },
    // Who this user reports to. Defines the team for the TEAM permission scope.
    managerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    status: { type: String, required: true, enum: USER_STATUSES, default: 'invited', index: true },
    // True when the email is on the company Workspace domain. Only these users may connect
    // Gmail and Calendar (phase 06).
    isWorkspaceAccount: { type: Boolean, required: true, default: false },
    // The user's own mobile number, used as the agent leg of click-to-call (phase 04).
    phone: { type: String, trim: true },
    theme: { type: String, required: true, enum: THEMES, default: 'light' },
    // Master switch: when false no notification is created, stored or delivered for this user.
    notificationsEnabled: { type: Boolean, required: true, default: true },
    notificationPrefs: { type: mongoose.Schema.Types.Mixed, default: {} },
    lastLoginAt: { type: Date },
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    deactivatedAt: { type: Date },
  },
  { timestamps: true },
);

export const User = mongoose.models.User ?? mongoose.model('User', userSchema);
