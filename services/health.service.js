import { isMongoUp } from '../infra/mongo.js';
import { getRedisStatus } from '../infra/redis.js';
import { isStorageConfigured } from '../infra/storage.js';

/**
 * Component-level health.
 * - MongoDB is required: without it the app is "down".
 * - Redis is a helper: when it is configured but unreachable the app is "degraded", not down,
 *   because it must keep working without Redis (Master Prompt Section 75).
 */
export async function getHealth() {
  const mongoUp = await isMongoUp();
  const redis = getRedisStatus();

  let status = 'ok';
  if (redis === 'down') status = 'degraded';
  if (!mongoUp) status = 'down';

  return {
    status,
    components: {
      mongo: mongoUp ? 'up' : 'down',
      redis,
      storage: isStorageConfigured() ? 'configured' : 'not_configured',
    },
  };
}
