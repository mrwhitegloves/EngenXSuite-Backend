import multer from 'multer';
import { badRequest } from '../lib/errors.js';

// File uploads arrive as multipart form data. The file is kept in memory only for the length of
// the request (Cloud Run has no permanent disk) and goes straight to S3 from there.

const MB = 1024 * 1024;
export const MAX_AVATAR_BYTES = 2 * MB;

/**
 * Accept exactly one file in the form field "file", up to `maxBytes`.
 * Too large, too many, or missing → a normal 400 in our standard error shape.
 */
export function singleFileUpload({ maxBytes }) {
  const parse = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1 },
  }).single('file');

  return function uploadMiddleware(req, res, next) {
    parse(req, res, (error) => {
      if (error?.code === 'LIMIT_FILE_SIZE') {
        return next(badRequest(`The file is too large. The limit is ${maxBytes / MB} MB.`));
      }
      if (error) return next(badRequest('The upload could not be read.'));
      if (!req.file) return next(badRequest('Choose a file to upload.'));
      return next();
    });
  };
}
