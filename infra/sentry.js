import * as Sentry from '@sentry/node';
import { env } from '../config/env.js';

// Error tracking. When SENTRY_BACKEND is not set this file does nothing, so the app runs the
// same with or without it. Never used in tests.

const isEnabled = Boolean(env.SENTRY_BACKEND) && env.NODE_ENV !== 'test';

export function initSentry() {
  if (!isEnabled) return;
  Sentry.init({
    dsn: env.SENTRY_BACKEND,
    environment: env.NODE_ENV,
    // Only errors are sent. Performance tracing stays off: it is not needed at this size.
    tracesSampleRate: 0,
    // No request bodies, cookies or IP addresses: they can contain passwords and personal data.
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        if (event.request.headers) {
          delete event.request.headers.cookie;
          delete event.request.headers.authorization;
        }
      }
      return event;
    },
  });
}

/**
 * Report an unexpected error with the request id and, when known, the user id (never the email).
 * @param {unknown} error
 * @param {{ requestId?: string, userId?: unknown, path?: string }} [context]
 */
export function reportError(error, { requestId, userId, path } = {}) {
  if (!isEnabled) return;
  Sentry.withScope((scope) => {
    if (requestId) scope.setTag('request_id', requestId);
    if (path) scope.setTag('path', path);
    if (userId) scope.setUser({ id: String(userId) });
    Sentry.captureException(error);
  });
}

/** Give Sentry a moment to send what it has before the process stops. */
export async function flushSentry() {
  if (isEnabled) await Sentry.close(2000);
}
