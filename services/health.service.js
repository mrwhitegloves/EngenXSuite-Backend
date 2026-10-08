import { isMongoUp } from '../infra/mongo.js';

/**
 * Component-level health.
 * MongoDB is required: without it the app is "down".
 * Redis will be added here as "degraded" (not "down") when it is wired in, because the app
 * must keep working without it (Master Prompt Section 75).
 * @returns {Promise<{ status: 'ok' | 'down', components: { mongo: 'up' | 'down' } }>}
 */
export async function getHealth() {
  const mongoUp = await isMongoUp();
  return {
    status: mongoUp ? 'ok' : 'down',
    components: { mongo: mongoUp ? 'up' : 'down' },
  };
}
