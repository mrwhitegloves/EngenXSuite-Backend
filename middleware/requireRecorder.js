import { unauthorized } from '../lib/errors.js';
import { loadRecorderByToken } from '../services/recorderDevices.service.js';

/**
 * Route middleware for the meeting recorder (Chrome extension): the request carries the
 * recorder's own token ("Authorization: Bearer rec_…"), never a session cookie. Attaches
 * `req.user` exactly as requireAuth does, so authorize() and every service work unchanged,
 * and `req.recorder` (which laptop).
 */
export async function requireRecorder(req, res, next) {
  const header = req.get('authorization') ?? '';
  const [kind, token] = header.split(' ');
  if (kind !== 'Bearer' || !token) return next(unauthorized('Connect the recorder first'));
  try {
    const { user, device } = await loadRecorderByToken(token);
    req.user = user;
    req.recorder = device;
    return next();
  } catch (error) {
    return next(error);
  }
}
