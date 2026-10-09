import Redis from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

// The ONLY place a Redis connection is created (Master Prompt Section 75).
// Redis is a helper, never the source of truth: MongoDB holds the real data, and the app keeps
// working when Redis is missing or down.

let redis = null;
let isReady = false;

/** Open the connection once at startup. Does nothing when REDIS_URL is not set. Never throws. */
export function connectRedis() {
  if (!env.REDIS_URL || env.NODE_ENV === 'test' || redis) return;

  // Redis is the library's class; it is created once, here.
  redis = new Redis(env.REDIS_URL, {
    // Fail a command quickly instead of queueing it while Redis is away, so a request never
    // hangs waiting for Redis.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    // Keep trying to reconnect, more slowly each time, up to every 10 seconds.
    retryStrategy: (attempt) => Math.min(attempt * 500, 10_000),
  });

  redis.on('ready', () => {
    isReady = true;
    logger.info('Redis connected');
  });
  redis.on('end', () => {
    isReady = false;
  });
  // Without an error listener ioredis would crash the process on a connection problem.
  redis.on('error', (error) => {
    if (isReady) logger.warn({ code: error.code }, 'Redis connection problem');
    isReady = false;
  });
}

/** 'up' | 'down' | 'not_configured': used by the health check. */
export function getRedisStatus() {
  if (!env.REDIS_URL) return 'not_configured';
  return isReady ? 'up' : 'down';
}

/** The client when Redis is usable right now, otherwise null. Callers must handle null. */
export function getRedis() {
  return isReady ? redis : null;
}

export async function disconnectRedis() {
  if (!redis) return;
  await redis.quit().catch(() => {});
  redis = null;
  isReady = false;
}
