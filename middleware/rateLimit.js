import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { env } from '../config/env.js';
import { createAppError } from '../lib/errors.js';

// Rate limits (Master Prompt Section 75). The counters are kept in memory for now; when Redis is
// connected they move to the Redis store, with this in-memory store as the fallback.
// In-memory counters reset when the server restarts, which is acceptable for a single instance.

const MINUTE_MS = 60 * 1000;

/**
 * Build a limiter that answers 429 in our standard error shape.
 * @param {{ limit: number, windowMs: number, message: string,
 *           keyGenerator: (req: import('express').Request) => string, skip?: () => boolean }} options
 */
function createLimiter({ limit, windowMs, message, keyGenerator, skip }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // The automated tests call these routes many times; each limiter has its own test.
    skip: skip ?? (() => env.NODE_ENV === 'test'),
    keyGenerator,
    // express-rate-limit has already set the Retry-After header at this point.
    handler: (req, res, next) => next(createAppError('TOO_MANY_REQUESTS', 429, message)),
  });
}

// Counted per IP address AND email together, so one person mistyping cannot lock out a
// colleague, and one attacker cannot try many passwords for one account.
const ipAndEmail = (req) => {
  const emailPart = String(req.body?.email ?? '')
    .trim()
    .toLowerCase();
  return `${ipKeyGenerator(req.ip)}|${emailPart}`;
};

/** Sign-in attempts: 5 per 15 minutes per IP address and email. */
export function createLoginLimiter({ limit = 5, windowMs = 15 * MINUTE_MS, skip } = {}) {
  return createLimiter({
    limit,
    windowMs,
    skip,
    keyGenerator: ipAndEmail,
    message: 'Too many sign-in attempts. Please wait a few minutes and try again.',
  });
}

/** Password resets from the sign-in page: 5 per 15 minutes per IP address and email. */
export function createPasswordResetLimiter({ limit = 5, windowMs = 15 * MINUTE_MS, skip } = {}) {
  return createLimiter({
    limit,
    windowMs,
    skip,
    keyGenerator: ipAndEmail,
    message: 'Too many attempts. Please wait a few minutes and try again.',
  });
}

/** Viewing passwords on the Users screen: 60 per hour per signed-in user. */
export function createPasswordViewLimiter({ limit = 60, windowMs = 60 * MINUTE_MS, skip } = {}) {
  return createLimiter({
    limit,
    windowMs,
    skip,
    keyGenerator: (req) => `user:${req.user?._id ?? ipKeyGenerator(req.ip)}`,
    message: 'Too many passwords viewed. Please try again later.',
  });
}
