import { User } from '../models/user.model.js';
import { Role } from '../models/role.model.js';
import { forbidden, notFound, unauthorized } from '../lib/errors.js';
import { passwordsMatch } from '../infra/password.js';
import { revokeUserSessions } from '../lib/sessions.js';
import { writeAudit } from '../lib/audit.js';
import { toReadableUrl } from '../infra/storage.js';
import { importGooglePicture } from './avatar.service.js';

// Sign-in rules. Two ways in: email + password, and Google. Both work only for an account that
// already exists in the `users` collection; there is no public sign-up (decision 0009).

// One message for "not invited" and "deactivated", so the Google sign-in result does not reveal
// which email addresses exist in the CRM.
const NOT_ALLOWED_MESSAGE =
  'This Google account does not have access. Ask your administrator to create an account for you.';

const isOnDomain = (email, domain) => email.endsWith(`@${domain.toLowerCase()}`);

/**
 * Called after Google has confirmed who the person is.
 * Only a user that already exists (and is not deactivated) may continue.
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
    isWorkspaceAccount: isOnDomain(email, workspaceDomain),
  };
  // Take the Google picture when the user has none, or still has an older Google link
  // (Google changes these addresses, and old ones stop working).
  const hasOwnPicture = user.avatarUrl && !user.avatarUrl.includes('.googleusercontent.com/');
  if (profile.avatarUrl && !hasOwnPicture) update.avatarUrl = profile.avatarUrl;
  // Keep the name an administrator typed; only fill it in when it is a placeholder.
  if (profile.name && (!user.name || user.name === user.email)) update.name = profile.name;

  await User.updateOne({ _id: user._id }, { $set: update });

  // A user without a picture of their own gets their Google picture copied into our storage.
  // (A picture already stored with us, including one the user uploaded, is never replaced.)
  // Not awaited: sign-in must not wait for it, and the function never throws.
  const currentPicture = update.avatarUrl ?? user.avatarUrl;
  if (profile.avatarUrl && currentPicture === profile.avatarUrl) {
    void importGooglePicture({ userId: user._id, url: profile.avatarUrl });
  }
  return { userId: String(user._id) };
}

// One message for a wrong password, an unknown email, a deactivated account and an account
// without a password.
const WRONG_CREDENTIALS_MESSAGE = 'The email or password is not correct.';

/**
 * Email + password sign-in. Works only for accounts created in the CRM.
 * @param {{ email: string, password: string }} credentials  Already validated
 * @returns {Promise<{ userId: string }>}
 */
export async function signInWithPassword({ email, password }) {
  const user = await User.findOne({ email }).select('+password status');
  const passwordOk = passwordsMatch(password, user?.password);
  if (!user || !passwordOk || user.status === 'deactivated') {
    throw unauthorized(WRONG_CREDENTIALS_MESSAGE);
  }

  await User.updateOne({ _id: user._id }, { $set: { status: 'active', lastLoginAt: new Date() } });
  return { userId: String(user._id) };
}

/**
 * "Forgot password" (decision 0011): whoever enters the email of an existing, active user sets a
 * new password for that user. No email is sent and the old password is not asked.
 * The user is signed out everywhere, and the change is written to the audit log.
 *
 * @param {{ email: string, newPassword: string }} input  Already validated
 * @param {{ requestId?: string }} [context]
 */
export async function resetPasswordByEmail({ email, newPassword }, context = {}) {
  const user = await User.findOne({ email, status: { $ne: 'deactivated' } })
    .select('_id')
    .lean();
  if (!user) throw notFound('No user account uses this email.');

  await User.updateOne(
    { _id: user._id },
    { $set: { password: newPassword, passwordChangedAt: new Date() } },
  );
  await revokeUserSessions(user._id);
  await writeAudit({
    // Nobody is signed in on this route, so there is no actor: the entry records that the
    // password was changed from the sign-in page.
    action: 'user.password_reset_from_sign_in_page',
    entityType: 'users',
    entityId: user._id,
    requestId: context.requestId,
  });
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
    // A picture stored in our private bucket becomes a link the browser can open.
    avatarUrl: await toReadableUrl(user.avatarUrl),
    theme: user.theme,
    isWorkspaceAccount: user.isWorkspaceAccount,
    notificationsEnabled: user.notificationsEnabled,
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
    role: { id: String(user.role._id), name: user.role.name },
    // The client uses these only to hide what the user cannot do. The server still decides.
    grants: user.role.grants.map(({ feature, action, scope }) => ({ feature, action, scope })),
  };
}
