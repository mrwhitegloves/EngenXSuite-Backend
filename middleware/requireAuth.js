import { loadRequestUser } from '../services/auth.service.js';
import { createAppError, unauthorized } from '../lib/errors.js';

/**
 * Build the "must be signed in" middleware.
 * Loads the user fresh on every request, so a deactivation or a role change takes effect at once.
 * Attaches `req.user` = { _id, email, name, role: { name, grants }, teamUserIds, … }.
 *
 * A user who still has to choose their own password (new account, or reset by someone else) is
 * blocked from everything except the few routes that pass `allowPasswordChangePending`.
 */
function createRequireAuth({ allowPasswordChangePending = false } = {}) {
  return async function requireAuthMiddleware(req, res, next) {
    const userId = req.session?.userId;
    if (!userId) return next(unauthorized());

    const user = await loadRequestUser(userId);
    if (!user) {
      // The user was deactivated or removed after signing in: end the session.
      req.session.destroy(() => {});
      return next(unauthorized());
    }

    if (user.mustChangePassword && !allowPasswordChangePending) {
      return next(
        createAppError('PASSWORD_CHANGE_REQUIRED', 403, 'Set your own password to continue.'),
      );
    }

    req.user = user;
    return next();
  };
}

/** Use on every protected route. */
export const requireAuth = createRequireAuth();

/** Only for: who am I, change my password, sign out. */
export const requireAuthAllowingPasswordChange = createRequireAuth({
  allowPasswordChangePending: true,
});
