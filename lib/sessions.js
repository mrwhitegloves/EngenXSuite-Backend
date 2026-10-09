import mongoose from 'mongoose';
import { SESSION_COLLECTION } from '../middleware/session.js';
import { disconnectUser } from '../infra/realtime.js';

/**
 * Sign a user out everywhere by deleting their stored sessions.
 * Used when a user is deactivated or their password changes.
 * @param {unknown} userId
 * @param {{ exceptSessionId?: string }} [options]  Keep this one (the user's current browser)
 */
export async function revokeUserSessions(userId, { exceptSessionId } = {}) {
  const filter = { 'session.userId': String(userId) };
  if (exceptSessionId) filter._id = { $ne: exceptSessionId };
  await mongoose.connection.collection(SESSION_COLLECTION).deleteMany(filter);
  // Live connections were opened with those sessions: close them too. A browser whose session
  // was kept connects again by itself.
  disconnectUser(userId);
}
