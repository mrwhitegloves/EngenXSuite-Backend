import { User } from '../models/user.model.js';
import { Role } from '../models/role.model.js';
import { forbidden } from '../lib/errors.js';

// Sign-in rules. No passwords exist in this system: identity comes from Google, and access comes
// from the invite list (the `users` collection).

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
