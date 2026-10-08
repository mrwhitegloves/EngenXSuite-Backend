import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

// Reversible encryption for the few values that must be read back later (stored passwords that
// administrators may view, and later integration tokens). AES-256-GCM from Node's own crypto
// module: the key comes from ENCRYPTION_KEY and is never stored in the database.

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const key = Buffer.from(env.ENCRYPTION_KEY, 'base64');

/**
 * @param {string} plainText
 * @returns {string} "v1:<iv>:<authTag>:<cipherText>", each part base64
 */
export function encrypt(plainText) {
  // A fresh random IV for every value, so equal inputs never produce equal outputs.
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const cipherText = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), cipherText]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64')))
    .join(':');
}

/**
 * @param {string | null | undefined} encrypted  A value made by encrypt()
 * @returns {string | null} The original text, or null when there is nothing to decrypt or the
 *   value cannot be read (wrong key, damaged or tampered data). Never throws.
 */
export function decrypt(encrypted) {
  if (!encrypted) return null;
  try {
    const [version, iv, authTag, cipherText] = encrypted.split(':');
    if (version !== VERSION) return null;
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(cipherText, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}
