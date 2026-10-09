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

/**
 * A separate connection for the background-job library (BullMQ), which needs its own:
 * a worker waits on Redis for the next job, and that would block the shared connection.
 * Returns null when REDIS_URL is not set. The caller closes it with `.quit()`.
 * @param {'producer' | 'worker'} kind
 */
export function createQueueConnection(kind) {
  if (!env.REDIS_URL) return null;
  const connection = new Redis(env.REDIS_URL, {
    // BullMQ requires "never give up on a command" for workers. Adding a job (producer) must
    // fail quickly instead, so a request never hangs while Redis is away.
    maxRetriesPerRequest: kind === 'worker' ? null : 1,
    enableOfflineQueue: kind === 'worker',
    retryStrategy: (attempt) => Math.min(attempt * 500, 10_000),
  });
  connection.on('error', () => {
    // The shared connection above already logs connection problems once.
  });
  return connection;
}

export async function disconnectRedis() {
  if (!redis) return;
  await redis.quit().catch(() => {});
  redis = null;
  isReady = false;
}
