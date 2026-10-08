import pino from 'pino';
import { env } from '../config/env.js';

// Field names that must never reach the logs. pino replaces their values with "[REDACTED]".
// Add new sensitive field names here, not at the call sites.
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  '*.clientSecret',
  '*.pan',
  '*.gstin',
  '*.bankDetails',
  '*.phone',
  '*.email',
];

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
  base: { env: env.NODE_ENV },
});
