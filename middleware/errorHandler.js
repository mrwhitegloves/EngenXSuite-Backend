import { isAppError, notFound } from '../lib/errors.js';

// Any /api path that matched no route ends here.
export function apiNotFound(req, res, next) {
  next(notFound(`No API route for ${req.method} ${req.path}`));
}

// The single place that turns an error into a response.
// Known errors (made with createAppError) keep their status and message.
// Anything else is a bug or an outage: log it in full, tell the user nothing internal.
// eslint-disable-next-line no-unused-vars -- Express recognises error handlers by their four arguments
export function errorHandler(error, req, res, next) {
  // Malformed JSON bodies arrive from express.json() as a SyntaxError with status 400.
  const isBadJson = error?.type === 'entity.parse.failed';

  if (isAppError(error) || isBadJson) {
    const status = isBadJson ? 400 : error.status;
    req.log?.warn({ code: error.code, status }, error.message);
    res.status(status).json({
      error: {
        code: isBadJson ? 'BAD_REQUEST' : error.code,
        message: isBadJson ? 'The request body is not valid JSON' : error.message,
        ...(error.details !== undefined && !isBadJson ? { details: error.details } : {}),
        requestId: req.id,
      },
    });
    return;
  }

  req.log?.error({ err: error }, 'Unhandled error');
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong. Please try again.',
      requestId: req.id,
    },
  });
}
