import { loadRequestUser } from '../services/auth.service.js';
import { unauthorized } from '../lib/errors.js';

/**
 * Route middleware: the request must come from a signed-in, active user.
 * Loads the user fresh on every request, so a deactivation or a role change takes effect at once.
 * Attaches `req.user` = { _id, email, name, role: { name, grants }, teamUserIds, … }.
 */
export async function requireAuth(req, res, next) {
  const userId = req.session?.userId;
  if (!userId) return next(unauthorized());

  const user = await loadRequestUser(userId);
  if (!user) {
    // The user was deactivated or removed after signing in: end the session.
    req.session.destroy(() => {});
    return next(unauthorized());
  }

  req.user = user;
  return next();
}
