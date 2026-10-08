// Application errors are plain Error objects with a few extra fields, made by a factory function.
// No custom error class (decision 0005: functional code only).

/**
 * @param {string} code     Stable machine-readable code, e.g. "NOT_FOUND"
 * @param {number} status   HTTP status to send
 * @param {string} message  Safe to show to the user
 * @param {unknown} [details] Optional extra data, e.g. validation issues
 * @returns {Error & { isAppError: true, code: string, status: number, details?: unknown }}
 */
export function createAppError(code, status, message, details) {
  const error = new Error(message);
  error.isAppError = true;
  error.code = code;
  error.status = status;
  if (details !== undefined) error.details = details;
  return error;
}

/** @param {unknown} error */
export function isAppError(error) {
  return Boolean(error && typeof error === 'object' && error.isAppError === true);
}

// Shortcuts for the errors every feature needs.
export const badRequest = (message = 'Invalid request', details) =>
  createAppError('BAD_REQUEST', 400, message, details);
export const unauthorized = (message = 'Please sign in') =>
  createAppError('UNAUTHORIZED', 401, message);
export const forbidden = (message = 'You do not have permission to do this') =>
  createAppError('FORBIDDEN', 403, message);
export const notFound = (message = 'Not found') => createAppError('NOT_FOUND', 404, message);
export const conflict = (message = 'Conflict', details) =>
  createAppError('CONFLICT', 409, message, details);
