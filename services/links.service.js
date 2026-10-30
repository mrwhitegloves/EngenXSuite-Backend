import { randomBytes } from 'node:crypto';
import { Link } from '../models/link.model.js';
import { buildFilter, buildSort, runListQuery } from '../lib/queryBuilder.js';
import { badRequest, createAppError, notFound } from '../lib/errors.js';
import { writeAudit } from '../lib/audit.js';
import { isSecretBoxReady, open, seal } from '../lib/secretBox.js';
import {
  deleteObject,
  isStorageConfigured,
  keyFromUrl,
  toReadableUrl,
  uploadObject,
} from '../infra/storage.js';
import { detectImageType } from './avatar.service.js';

// Links (founder, 2026-10-30): name, address, description, credentials (key/value) and a
// thumbnail. Who may see and change them is the `links` feature (Settings → Roles).
// Rules:
// - credential values are sealed when saved and opened only here, for an answer;
// - credential values never go into the audit log (only which keys changed);
// - the thumbnail goes to S3 (private); the old one is removed when it is replaced.

const SORTS = { name: 'name', createdAt: 'createdAt', updatedAt: 'updatedAt' };

function sealCredentials(credentials) {
  const filled = credentials.filter((item) => item.key.trim());
  if (filled.some((item) => item.value) && !isSecretBoxReady()) {
    throw createAppError(
      'NOT_CONFIGURED',
      503,
      'Secure storage for credentials is not set up (ENCRYPTION_KEY).',
    );
  }
  return filled.map((item) => ({
    key: item.key.trim(),
    valueSealed: item.value ? seal(item.value) : '',
  }));
}

function openValue(sealed) {
  if (!sealed) return '';
  try {
    return open(sealed);
  } catch {
    return ''; // a value sealed with another key cannot be read
  }
}

async function toView(link) {
  return {
    id: String(link._id),
    name: link.name,
    url: link.url,
    description: link.description ?? '',
    credentials: (link.credentials ?? []).map((item) => ({
      key: item.key,
      value: openValue(item.valueSealed),
    })),
    thumbnailUrl: link.thumbnailUrl ? await toReadableUrl(link.thumbnailUrl) : null,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
  };
}

/** Audit view of a change: credential keys only, never their values. */
const auditable = (data) => ({
  ...data,
  ...(data.credentials ? { credentials: data.credentials.map((item) => item.key) } : {}),
});

export async function listLinks(query) {
  const filter = buildFilter({
    search: { text: query.search, fields: ['name', 'url', 'description'] },
  });
  const { rows, pagination } = await runListQuery(Link, {
    filter,
    sort: buildSort(query.sort, SORTS, 'name'),
    page: query.page,
    pageSize: query.pageSize,
  });
  return { items: await Promise.all(rows.map(toView)), pagination };
}

export async function createLink(actor, data, context = {}) {
  const link = await Link.create({
    ...data,
    credentials: sealCredentials(data.credentials),
    createdBy: actor._id,
    updatedBy: actor._id,
  });
  await writeAudit({
    actor,
    action: 'link.created',
    entityType: 'links',
    entityId: link._id,
    newValue: auditable(data),
    requestId: context.requestId,
  });
  return toView(link.toObject());
}

export async function updateLink(actor, linkId, changes, context = {}) {
  const before = await Link.findById(linkId).lean();
  if (!before) throw notFound('Link not found');
  const set = { ...changes, updatedBy: actor._id };
  if (changes.credentials) set.credentials = sealCredentials(changes.credentials);
  const after = await Link.findByIdAndUpdate(
    linkId,
    { $set: set },
    { returnDocument: 'after' },
  ).lean();
  await writeAudit({
    actor,
    action: 'link.updated',
    entityType: 'links',
    entityId: linkId,
    oldValue: auditable(
      Object.fromEntries(
        Object.keys(changes).map((key) => [
          key,
          key === 'credentials' ? before.credentials : before[key],
        ]),
      ),
    ),
    newValue: auditable(changes),
    requestId: context.requestId,
  });
  return toView(after);
}

export async function deleteLink(actor, linkId, context = {}) {
  const link = await Link.findByIdAndDelete(linkId).lean();
  if (!link) throw notFound('Link not found');
  const key = keyFromUrl(link.thumbnailUrl);
  if (key) await deleteObject(key);
  await writeAudit({
    actor,
    action: 'link.deleted',
    entityType: 'links',
    entityId: linkId,
    oldValue: { name: link.name, url: link.url },
    requestId: context.requestId,
  });
  return { id: String(link._id) };
}

/** A new thumbnail (PNG, JPG or WebP, checked from the file's bytes). */
export async function saveThumbnail(actor, linkId, file, context = {}) {
  const type = detectImageType(file.buffer);
  if (!type) throw badRequest('Choose a PNG, JPG or WebP image.');
  if (!isStorageConfigured()) {
    throw createAppError('NOT_CONFIGURED', 503, 'File storage is not set up yet.');
  }
  const link = await Link.findById(linkId).select('thumbnailUrl').lean();
  if (!link) throw notFound('Link not found');
  // A random name: never guessable, never a stale cached picture.
  const key = `links/${link._id}/${randomBytes(12).toString('hex')}.${type.extension}`;
  const url = await uploadObject({ key, body: file.buffer, contentType: type.contentType });
  await Link.updateOne({ _id: link._id }, { $set: { thumbnailUrl: url, updatedBy: actor._id } });
  const previousKey = keyFromUrl(link.thumbnailUrl);
  if (previousKey) await deleteObject(previousKey);
  await writeAudit({
    actor,
    action: 'link.thumbnail_changed',
    entityType: 'links',
    entityId: link._id,
    requestId: context.requestId,
  });
  return { thumbnailUrl: await toReadableUrl(url) };
}

export async function removeThumbnail(actor, linkId, context = {}) {
  const link = await Link.findByIdAndUpdate(linkId, {
    $set: { thumbnailUrl: null, updatedBy: actor._id },
  }).lean();
  if (!link) throw notFound('Link not found');
  const key = keyFromUrl(link.thumbnailUrl);
  if (key) await deleteObject(key);
  await writeAudit({
    actor,
    action: 'link.thumbnail_removed',
    entityType: 'links',
    entityId: link._id,
    requestId: context.requestId,
  });
  return { thumbnailUrl: null };
}
