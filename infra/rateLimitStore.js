import { MemoryStore } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { env } from '../config/env.js';
import { getRedis } from './redis.js';

// Where the rate limiter keeps its counters: in Redis when Redis is usable, otherwise in this
// process's memory (Master Prompt Section 75: "if Redis is down, fall back to an in-memory
// limiter"). Redis counters survive a server restart; memory counters do not, which is
// acceptable as a fallback.

/**
 * Build one store for one limiter. `name` keeps each limiter's counters apart in Redis.
 * The returned object has the methods express-rate-limit expects from a store.
 */
export function createRateLimitStore(name) {
  // MemoryStore and RedisStore are the libraries' classes; each is created once per limiter.
  const memory = new MemoryStore();
  let redisStore = null;
  let options = null;

  // The Redis store is created only when Redis is actually connected, because creating it
  // sends a command to Redis straight away.
  function getRedisStore() {
    const redis = getRedis();
    if (!redis) return null;
    if (!redisStore) {
      redisStore = new RedisStore({
        // The environment is in the key: development and production may share one Redis.
        prefix: `rl:${env.NODE_ENV}:${name}:`,
        sendCommand: (command, ...args) => {
          const client = getRedis();
          if (!client) return Promise.reject(new Error('Redis is not available'));
          return client.call(command, ...args);
        },
      });
      redisStore.init(options);
    }
    return redisStore;
  }

  // Try Redis; on any problem do the same thing in memory, so the limit is still enforced.
  async function withFallback(method, key) {
    const store = getRedisStore();
    if (store) {
      try {
        return await store[method](key);
      } catch {
        // Fall through to memory.
      }
    }
    return memory[method](key);
  }

  return {
    // Counters are shared between server instances only while they are in Redis.
    localKeys: false,
    init(limiterOptions) {
      options = limiterOptions;
      memory.init(limiterOptions);
    },
    increment: (key) => withFallback('increment', key),
    decrement: (key) => withFallback('decrement', key),
    resetKey: (key) => withFallback('resetKey', key),
  };
}
