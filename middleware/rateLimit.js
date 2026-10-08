import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { env } from '../config/env.js';
import { createAppError } from '../lib/errors.js';

// Rate limits (Master Prompt Section 75). The counters are kept in memory for now; when Redis is
// connected they move to the Redis store, with this in-memory store as the fallback.
// In-memory counters reset when the server restarts, which is acceptable for a single instance.

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

/**
 * Sign-in attempts: 5 per 15 minutes, counted per IP address AND email together, so one person
 * mistyping their password cannot lock out a colleague, and one attacker cannot try many
 * passwords for one account.
 * @param {{ limit?: number, windowMs?: number, skip?: () => boolean }} [options]
 */
export function createLoginLimiter({ limit = 5, windowMs = FIFTEEN_MINUTES_MS, skip } = {}) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // The automated tests sign in many times; the limiter has its own test.
    skip: skip ?? (() => env.NODE_ENV === 'test'),
    keyGenerator: (req) => {
      const emailPart = String(req.body?.email ?? '')
        .trim()
        .toLowerCase();
      return `${ipKeyGenerator(req.ip)}|${emailPart}`;
    },
    // Our standard error shape, through the normal error handler. express-rate-limit has
    // already set the Retry-After header at this point.
    handler: (req, res, next) => {
      next(
        createAppError(
          'TOO_MANY_REQUESTS',
          429,
          'Too many sign-in attempts. Please wait a few minutes and try again.',
        ),
      );
    },
  });
}
