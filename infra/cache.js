import { env } from '../config/env.js';
import { getRedis } from './redis.js';
import { logger } from './logger.js';

// Cache-aside on Redis (Master Prompt Section 75). Three rules:
//   1. The cache is never the source of truth: MongoDB is. A cached value is only a saved copy.
//   2. A cache problem never breaks a request: on any Redis trouble the real data is fetched.
//   3. Every key has a lifetime, and data that depends on who is asking must carry the user id
//      or scope in its key, so one user can never receive another user's data.

// The environment is part of every key: development and production may share one Redis, and
// must never read each other's cached data (they have different databases).
const PREFIX = `cache:v1:${env.NODE_ENV}:`;

/**
 * Return the cached value for `key`, or fetch it, cache it for `ttlSeconds`, and return it.
 *
 * @template T
 * @param {string} key          Without the prefix, e.g. "branding" or `dashboard:${userId}`
 * @param {number} ttlSeconds   From config/cacheTtl.js
 * @param {() => Promise<T>} fetchFn  Reads the real data (from MongoDB)
 * @returns {Promise<T>}
 */
export async function getOrSet(key, ttlSeconds, fetchFn) {
  const redis = getRedis();
  if (!redis) return fetchFn();

  const fullKey = `${PREFIX}${key}`;
  try {
    const cached = await redis.get(fullKey);
    if (cached !== null) return JSON.parse(cached);
  } catch (error) {
    logger.warn({ err: error, key }, 'Cache read failed; using the database');
    return fetchFn();
  }

  // An error from fetchFn is a real error and is passed on; it is never cached.
  const fresh = await fetchFn();
  try {
    // `undefined` cannot be stored as JSON; it is simply not cached.
    if (fresh !== undefined) await redis.set(fullKey, JSON.stringify(fresh), 'EX', ttlSeconds);
  } catch (error) {
    logger.warn({ err: error, key }, 'Cache write failed');
  }
  return fresh;
}

/**
 * Delete cached values after the real data changed. Call it from the same service function that
 * saves the change. `keys` are without the prefix. Never throws.
 * @param {...string} keys
 */
export async function invalidate(...keys) {
  const redis = getRedis();
  if (!redis || keys.length === 0) return;
  try {
    await redis.del(...keys.map((key) => `${PREFIX}${key}`));
  } catch (error) {
    logger.warn({ err: error }, 'Cache invalidation failed; entries expire by themselves');
  }
}
