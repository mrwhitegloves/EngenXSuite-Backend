import bcrypt from 'bcryptjs';
import { decrypt, encrypt } from './crypto.js';

// Everything about passwords lives in this file. Nothing else hashes, compares, encrypts or
// decrypts a password, and no password is ever logged.
//
// Two copies are stored for each password (decision 0010):
//   passwordHash  a one-way bcrypt hash. This is what sign-in checks.
//   passwordEnc   an AES-256-GCM encrypted copy, so the CEO and the user's manager can view it.

// Work factor: each +1 doubles the time to check one guess. 12 is roughly a quarter of a second
// per attempt on current hardware, slow for an attacker and unnoticeable for a user.
const COST = 12;

// bcrypt only reads the first 72 bytes of a password. Longer ones are refused by the validation
// schema, so two different long passwords can never be treated as the same.
export const MAX_PASSWORD_BYTES = 72;
export const MIN_PASSWORD_LENGTH = 10;

/** @param {string} password @returns {Promise<string>} */
export function hashPassword(password) {
  return bcrypt.hash(password, COST);
}

/**
 * The fields to store on a user whenever their password is set or changed.
 * Every place that sets a password uses this, so the two copies can never disagree.
 * @param {string} password
 */
export async function buildPasswordFields(password) {
  return {
    passwordHash: await hashPassword(password),
    passwordEnc: encrypt(password),
    passwordChangedAt: new Date(),
  };
}

/**
 * The readable password for an administrator to view.
 * @param {string | null | undefined} passwordEnc
 * @returns {string | null} null when no readable copy exists (password set before decision 0010)
 */
export function readStoredPassword(passwordEnc) {
  return decrypt(passwordEnc);
}

// A valid hash of a random value. Used when the email is unknown, so "no such user" takes the
// same time as "wrong password" and timing cannot reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-placeholder', COST);

/**
 * @param {string} password
 * @param {string | null | undefined} passwordHash  Missing when the user has no password set
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, passwordHash) {
  const matches = await bcrypt.compare(password, passwordHash || DUMMY_HASH);
  return Boolean(passwordHash) && matches;
}
