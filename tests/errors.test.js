import { describe, expect, it } from 'vitest';
import { createAppError, isAppError, notFound } from '../lib/errors.js';

describe('application errors', () => {
  it('createAppError returns a normal Error with code, status and details', () => {
    const error = createAppError('CONFLICT', 409, 'Already exists', { field: 'email' });
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('CONFLICT');
    expect(error.status).toBe(409);
    expect(error.details).toEqual({ field: 'email' });
    expect(isAppError(error)).toBe(true);
  });

  it('isAppError is false for ordinary errors and other values', () => {
    expect(isAppError(new Error('boom'))).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError('text')).toBe(false);
  });

  it('shortcuts carry the right status', () => {
    expect(notFound().status).toBe(404);
  });
});
