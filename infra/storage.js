import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';
import { createAppError } from '../lib/errors.js';
import { logger } from './logger.js';

// The only file that talks to AWS S3. The buckets are private: a file is reached through a
// signed link that works for a short time, never through a public address.

let client = null;

export function isStorageConfigured() {
  return Boolean(
    env.AWS_S3_IAM_ACCESS_KEY_ID &&
    env.AWS_S3_IAM_SECRET_ACCESS_KEY &&
    env.AWS_REGION &&
    env.S3_BUCKET,
  );
}

function getClient() {
  if (!isStorageConfigured()) {
    throw createAppError('STORAGE_NOT_CONFIGURED', 503, 'File storage is not set up yet.');
  }
  if (!client) {
    // S3Client is the library's class; it is created once, here.
    client = new S3Client({
      region: env.AWS_REGION,
      credentials: {
        accessKeyId: env.AWS_S3_IAM_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_S3_IAM_SECRET_ACCESS_KEY,
      },
    });
  }
  return client;
}

// The plain S3 address of an object. This is what is saved in the database. It cannot be opened
// directly (the bucket is private); toReadableUrl() turns it into a link that works.
const bucketBaseUrl = () => `https://${env.S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/`;

export function objectUrl(key) {
  return `${bucketBaseUrl()}${key}`;
}

/** The object key when the address points into our bucket; otherwise null. */
export function keyFromUrl(url) {
  if (!url || !isStorageConfigured() || !url.startsWith(bucketBaseUrl())) return null;
  return url.slice(bucketBaseUrl().length);
}

/**
 * Store a file.
 * @param {{ key: string, body: Buffer, contentType: string }} file
 * @returns {Promise<string>} The S3 address of the stored object
 */
export async function uploadObject({ key, body, contentType }) {
  await getClient().send(
    new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: body, ContentType: contentType }),
  );
  return objectUrl(key);
}

/**
 * Read a stored file into memory. For files our own code wrote (backups), never for user uploads
 * of unknown size.
 * @returns {Promise<Buffer | null>} null when no object has this key
 */
export async function readObject(key) {
  try {
    const response = await getClient().send(
      new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
    );
    return Buffer.from(await response.Body.transformToByteArray());
  } catch (error) {
    if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}

/** Remove a file. A failure is logged and ignored: a leftover object must not break a request. */
export async function deleteObject(key) {
  try {
    await getClient().send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  } catch (error) {
    logger.warn({ err: error }, 'Stored file could not be deleted');
  }
}

/**
 * Turn a saved address into one the browser can open.
 * An address in our bucket becomes a signed link (valid for an hour); any other address
 * (for example a Google profile picture) is returned unchanged. Signing is a local calculation,
 * so this makes no network call.
 * @param {string | null | undefined} url
 * @returns {Promise<string | null>}
 */
export async function toReadableUrl(url, expiresInSeconds = 3600) {
  if (!url) return null;
  const key = keyFromUrl(url);
  if (!key) return url;
  return getSignedUrl(getClient(), new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }), {
    expiresIn: expiresInSeconds,
  });
}
