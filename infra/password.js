import { createHash, timingSafeEqual } from 'node:crypto';

// Passwords are stored exactly as typed, in the `password` field of a user (founder and CEO
// decision 0011). There is no hashing and no encryption. This file is the one place that
// compares a typed password with the stored one.

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 200;

const digest = (text) => createHash('sha256').update(String(text), 'utf8').digest();

/**
 * Is the typed password the stored one?
 * The two values are compared through fixed-length digests in constant time, so the time the
 * check takes does not reveal how many leading characters were right. (Nothing is stored hashed;
 * the digests exist only for this comparison.)
 * @param {string} typed
 * @param {string | null | undefined} stored  Missing when the user has no password set
 * @returns {boolean}
 */
export function passwordsMatch(typed, stored) {
  const equal = timingSafeEqual(digest(typed), digest(stored ?? ''));
  return Boolean(stored) && equal;
}
