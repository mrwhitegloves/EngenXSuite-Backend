import { can } from '../lib/can.js';
import { forbidden, unauthorized } from '../lib/errors.js';

/**
 * Route middleware: "may the signed-in user perform this action on this feature at all?"
 * Record-level checks (is THIS account inside the user's scope) happen in the service, because
 * they need the record; those answer 404 so the existence of a record is not revealed.
 *
 * Usage in a routes file:  router.post('/', requireAuth, authorize('accounts', 'create'), createAccount)
 */
export function authorize(feature, action) {
  return function authorizeRequest(req, res, next) {
    if (!req.user) return next(unauthorized());
    if (!can(req.user, action, { feature })) return next(forbidden());
    return next();
  };
}
