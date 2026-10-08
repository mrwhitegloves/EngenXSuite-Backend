import bcrypt from 'bcryptjs';

// Password hashing through bcrypt (a proven library). Nothing else in the code base hashes or
// compares passwords, and no password is ever stored or logged in plain text.

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
