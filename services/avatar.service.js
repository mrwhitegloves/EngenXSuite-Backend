import { randomBytes } from 'node:crypto';
import { User } from '../models/user.model.js';
import { deleteObject, keyFromUrl, uploadObject } from '../infra/storage.js';
import { badRequest, notFound } from '../lib/errors.js';
import { writeAudit } from '../lib/audit.js';

// Profile pictures: the image goes to S3 and only its S3 address is saved on the user
// (`users.avatarUrl`). Used for a user's own picture and by administrators editing a user.

// The real type of a file is read from its first bytes, never from its name or from what the
// browser claims: a script renamed to "photo.png" is rejected here.
const IMAGE_TYPES = [
  { extension: 'png', contentType: 'image/png', signature: [0x89, 0x50, 0x4e, 0x47] },
  { extension: 'jpg', contentType: 'image/jpeg', signature: [0xff, 0xd8, 0xff] },
  // WebP: "RIFF" at byte 0 and "WEBP" at byte 8.
  { extension: 'webp', contentType: 'image/webp', signature: [0x52, 0x49, 0x46, 0x46], webp: true },
];

function detectImageType(buffer) {
  return IMAGE_TYPES.find(
    (type) =>
      type.signature.every((byte, index) => buffer[index] === byte) &&
      (!type.webp || buffer.subarray(8, 12).toString('ascii') === 'WEBP'),
  );
}

/**
 * Save a new profile picture for a user and remove the previous one from storage.
 * The caller has already checked that the actor may change this user.
 * @param {{ actor: object, userId: unknown, file: { buffer: Buffer }, requestId?: string }} input
 * @returns {Promise<string>} The S3 address saved on the user
 */
export async function saveAvatar({ actor, userId, file, requestId }) {
  const type = detectImageType(file.buffer);
  if (!type) throw badRequest('Choose a PNG, JPG or WebP image.');

  const user = await User.findById(userId).select('avatarUrl').lean();
  if (!user) throw notFound('User not found');

  // A random name: the address cannot be guessed, and a new picture never reuses an old address
  // (so a browser never shows a stale cached picture).
  const key = `avatars/${user._id}/${randomBytes(12).toString('hex')}.${type.extension}`;
  const url = await uploadObject({ key, body: file.buffer, contentType: type.contentType });

  await User.updateOne({ _id: user._id }, { $set: { avatarUrl: url } });
  const previousKey = keyFromUrl(user.avatarUrl);
  if (previousKey) await deleteObject(previousKey);

  await writeAudit({
    actor,
    action: 'user.avatar_changed',
    entityType: 'users',
    entityId: user._id,
    requestId,
  });
  return url;
}

/** Remove a user's profile picture; the initials are shown again. */
export async function removeAvatar({ actor, userId, requestId }) {
  const user = await User.findById(userId).select('avatarUrl').lean();
  if (!user) throw notFound('User not found');
  if (!user.avatarUrl) return;

  await User.updateOne({ _id: user._id }, { $unset: { avatarUrl: '' } });
  const key = keyFromUrl(user.avatarUrl);
  if (key) await deleteObject(key);

  await writeAudit({
    actor,
    action: 'user.avatar_removed',
    entityType: 'users',
    entityId: user._id,
    requestId,
  });
}
