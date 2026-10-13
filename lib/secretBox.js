import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

// Encrypts a secret that has to be kept in the database and used again later (a person's
// Google token). AES-256-GCM with the key from ENCRYPTION_KEY: without that key, what is stored
// is of no use to anyone who reads the database or a backup.
// (Login passwords are a different matter: decision 0011.)
//
// Stored form: "v1.<iv>.<tag>.<data>", each part base64url.

const VERSION = 'v1';

function key() {
  if (!env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY is not set');
  return Buffer.from(env.ENCRYPTION_KEY, 'base64');
}

export const isSecretBoxReady = () => Boolean(env.ENCRYPTION_KEY);

/** @param {string} text  @returns {string} The sealed form, safe to store */
export function seal(text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), data]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}

/** @param {string} sealed  @returns {string} The secret; throws when it was changed or the key differs */
export function open(sealed) {
  const [version, iv, tag, data] = String(sealed).split('.');
  if (version !== VERSION || !iv || !tag || !data) throw new Error('Not a sealed secret');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
