import { User } from '../models/user.model.js';
import { Role } from '../models/role.model.js';
import { badRequest, forbidden, unauthorized } from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../infra/password.js';
import { revokeUserSessions } from '../lib/sessions.js';
import { writeAudit } from '../lib/audit.js';

// Sign-in rules. Two ways in: email + password, and Google. Both work only for an account that
// already exists in the `users` collection; there is no public sign-up (decision 0009).

// One message for "not invited" and "deactivated", so the sign-in page never reveals which
// email addresses exist in the CRM.
const NOT_ALLOWED_MESSAGE =
  'This Google account does not have access. Ask your administrator to invite you.';

/**
 * Called after Google has confirmed who the person is.
 * Only an invited (or already active) user may continue; everyone else is refused.
 *
 * @param {{ googleId: string, email: string, emailVerified: boolean, name?: string, avatarUrl?: string }} profile
 * @param {{ workspaceDomain: string }} options
 * @returns {Promise<{ userId: string }>}
 */
export async function signInWithGoogle(profile, { workspaceDomain }) {
  const email = String(profile.email ?? '')
    .trim()
    .toLowerCase();
  if (!email || profile.emailVerified === false) throw forbidden(NOT_ALLOWED_MESSAGE);

  const user = await User.findOne({ email });
  if (!user || user.status === 'deactivated') throw forbidden(NOT_ALLOWED_MESSAGE);

  // The same email must always be the same Google account. A different Google id for a known
  // email would mean the address was re-created by someone else.
  if (user.googleId && user.googleId !== profile.googleId) throw forbidden(NOT_ALLOWED_MESSAGE);

  const update = {
    googleId: profile.googleId,
    status: 'active',
    lastLoginAt: new Date(),
    isWorkspaceAccount: email.endsWith(`@${workspaceDomain.toLowerCase()}`),
  };
  if (profile.avatarUrl) update.avatarUrl = profile.avatarUrl;
  // Keep the name an administrator typed at invite time; only fill it in when it is a placeholder.
  if (profile.name && (!user.name || user.name === user.email)) update.name = profile.name;

  await User.updateOne({ _id: user._id }, { $set: update });
  return { userId: String(user._id) };
}

// One message for a wrong password, an unknown email, a deactivated account and an account
// without a password, so the sign-in page never reveals which emails exist.
const WRONG_CREDENTIALS_MESSAGE = 'The email or password is not correct.';

/**
 * Email + password sign-in (decision 0009). Works only for accounts created in the CRM.
 * @param {{ email: string, password: string }} credentials  Already validated
 * @returns {Promise<{ userId: string }>}
 */
export async function signInWithPassword({ email, password }) {
  const user = await User.findOne({ email }).select('+passwordHash status');
  // verifyPassword always does a full bcrypt comparison, also when the user does not exist,
  // so the response time is the same in both cases.
  const passwordOk = await verifyPassword(password, user?.passwordHash);
  if (!user || !passwordOk || user.status === 'deactivated') {
    throw unauthorized(WRONG_CREDENTIALS_MESSAGE);
  }

  await User.updateOne({ _id: user._id }, { $set: { status: 'active', lastLoginAt: new Date() } });
  return { userId: String(user._id) };
}

/**
 * The signed-in user chooses a new password. Their other sessions are ended.
 * @param {string} userId
 * @param {{ currentPassword: string, newPassword: string }} input  Already validated
 * @param {{ keepSessionId?: string }} [options]
 */
export async function changeMyPassword(userId, { currentPassword, newPassword }, options = {}) {
  const user = await User.findById(userId).select('+passwordHash');
  const currentOk = await verifyPassword(currentPassword, user?.passwordHash);
  if (!user || !currentOk) throw badRequest('Your current password is not correct.');

  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        passwordHash: await hashPassword(newPassword),
        mustChangePassword: false,
        passwordChangedAt: new Date(),
      },
    },
  );
  await revokeUserSessions(user._id, { exceptSessionId: options.keepSessionId });
  await writeAudit({
    actor: { _id: user._id },
    action: 'user.password_changed',
    entityType: 'users',
    entityId: user._id,
  });
  return loadRequestUser(user._id);
}

/**
 * Load the user for a request: the user, their role's grants, and the ids of the people who
 * report to them (needed for the TEAM permission scope). Returns null when the session's user
 * no longer exists or is not active, which signs them out on their next request.
 *
 * @param {string} userId
 */
export async function loadRequestUser(userId) {
  const user = await User.findById(userId).lean();
  if (!user || user.status !== 'active') return null;

  const [role, reports] = await Promise.all([
    Role.findById(user.roleId).lean(),
    User.find({ managerId: user._id, status: { $ne: 'deactivated' } })
      .select('_id')
      .lean(),
  ]);
  if (!role) return null;

  return {
    _id: user._id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl ?? null,
    theme: user.theme,
    isWorkspaceAccount: user.isWorkspaceAccount,
    notificationsEnabled: user.notificationsEnabled,
    mustChangePassword: user.mustChangePassword === true,
    role: { _id: role._id, name: role.name, grants: role.grants },
    teamUserIds: reports.map((report) => report._id),
  };
}

/**
 * Save the signed-in user's own display preferences.
 * @param {string} userId
 * @param {{ theme?: 'light' | 'dark' | 'system' }} preferences  Already validated
 */
export async function updateMyPreferences(userId, preferences) {
  await User.updateOne({ _id: userId }, { $set: preferences });
  return loadRequestUser(userId);
}

/** The part of the request user that is safe and useful to send to the browser. */
export function toPublicUser(user) {
  return {
    id: String(user._id),
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    theme: user.theme,
    isWorkspaceAccount: user.isWorkspaceAccount,
    notificationsEnabled: user.notificationsEnabled,
    mustChangePassword: user.mustChangePassword,
    role: { id: String(user.role._id), name: user.role.name },
    // The client uses these only to hide what the user cannot do. The server still decides.
    grants: user.role.grants.map(({ feature, action, scope }) => ({ feature, action, scope })),
  };
}
