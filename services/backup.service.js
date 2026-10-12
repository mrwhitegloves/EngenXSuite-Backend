import { gunzipSync, gzipSync } from 'node:zlib';
import mongoose from 'mongoose';
import {
  BACKUP_CHUNK_DOCUMENTS,
  BACKUP_DELETE_TIME,
  BACKUP_INDEX_KEY,
  BACKUP_KEEP_AT_LEAST,
  BACKUP_KEEP_DAYS,
  BACKUP_NOTIFY_MINUTES_BEFORE,
  BACKUP_PREFIX,
  BACKUP_SKIP_COLLECTIONS,
  BACKUP_STALE_DAYS,
} from '../config/backup.js';
import { JOB_NAMES } from '../constants/jobNames.js';
import { logger } from '../infra/logger.js';
import { enqueue } from '../infra/queues.js';
import { deleteObject, isStorageConfigured, readObject, uploadObject } from '../infra/storage.js';
import { writeAudit } from '../lib/audit.js';
import { badRequest, conflict, createAppError, notFound } from '../lib/errors.js';
import { Role } from '../models/role.model.js';
import { Settings } from '../models/settings.model.js';
import { User } from '../models/user.model.js';
import { notify } from './notifications.service.js';

// Our own database backup (the Atlas Free tier has none). Every collection is copied to the
// private storage bucket, and can be copied back into an EMPTY, SEPARATE database.
//
// Format, readable without any tool of ours:
//   backups/<id>/manifest.json                 what the backup holds (written last)
//   backups/<id>/<collection>/00001.jsonl.gz   one document per line, gzip-compressed
//   backups/index.json                         the list of finished backups
// Documents are written as MongoDB Extended JSON, which keeps exact types (ids, dates, numbers).
//
// A backup holds everything in the database, including the users' passwords (decision 0011).
// It is as sensitive as the database itself: private bucket only, never a public link.

const { EJSON } = mongoose.mongo.BSON;
const DAY_MS = 24 * 60 * 60 * 1000;

const fileKey = (backupId, collection, number) =>
  `${BACKUP_PREFIX}${backupId}/${collection}/${String(number).padStart(5, '0')}.jsonl.gz`;
const manifestKey = (backupId) => `${BACKUP_PREFIX}${backupId}/manifest.json`;

const toJsonBuffer = (value) => Buffer.from(JSON.stringify(value, null, 2));

async function readJson(key) {
  const buffer = await readObject(key);
  return buffer ? JSON.parse(buffer.toString('utf8')) : null;
}

/** Finished backups, newest first: [{ id, createdAt, documents, bytes, collections }]. */
export async function listBackups() {
  const index = await readJson(BACKUP_INDEX_KEY);
  return [...(index?.backups ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The clean-up times from Settings → Backups (the starting values until someone saves). */
async function readCleanupSettings() {
  const settings = await Settings.findOne({ key: 'app' }).select('backups').lean();
  return {
    deleteTime: settings?.backups?.deleteTime ?? BACKUP_DELETE_TIME,
    notifyMinutesBefore: settings?.backups?.notifyMinutesBefore ?? BACKUP_NOTIFY_MINUTES_BEFORE,
    lastCleanupDay: settings?.backups?.lastCleanupDay ?? null,
    lastWarningDay: settings?.backups?.lastWarningDay ?? null,
  };
}

/** What Settings → Backups shows: whether storage is set up, the backups, and the clean-up times. */
export async function getBackupsOverview(now = new Date()) {
  if (!isStorageConfigured()) return { storage: 'not_configured', backups: [], isStale: false };
  const { deleteTime, notifyMinutesBefore } = await readCleanupSettings();
  const backups = await listBackups();
  // Stale: the newest backup is older than two nights, so the nightly job is not working.
  const newest = backups[0];
  const isStale = Boolean(newest) && now - new Date(newest.createdAt) > BACKUP_STALE_DAYS * DAY_MS;
  return {
    storage: 'configured',
    backups,
    isStale,
    cleanup: { deleteTime, notifyMinutesBefore, keepDays: BACKUP_KEEP_DAYS },
  };
}

/**
 * Change when old backups are deleted and how long before that people are told.
 * @param {{ deleteTime?: string, notifyMinutesBefore?: number }} changes  Already validated
 */
export async function updateBackupCleanup(actor, changes, context = {}) {
  const set = Object.fromEntries(
    Object.entries(changes).map(([field, value]) => [`backups.${field}`, value]),
  );
  const settings = await Settings.findOneAndUpdate({ key: 'app' }, { $set: set }).lean();
  if (!settings) throw badRequest('The settings are not set up yet. Run the seed first.');
  await writeAudit({
    actor,
    action: 'settings.backups_updated',
    entityType: 'settings',
    entityId: settings._id,
    newValue: changes,
    requestId: context.requestId,
  });
  return (await getBackupsOverview()).cleanup;
}

/** Start a backup now, as a background job. Fails with a clear message when Redis is down. */
export async function requestBackup(actor) {
  if (!isStorageConfigured()) {
    throw createAppError('STORAGE_NOT_CONFIGURED', 503, 'File storage is not set up yet.');
  }
  const job = await enqueue('integrations', JOB_NAMES.databaseBackup, {});
  logger.info({ userId: String(actor._id), jobId: job.id }, 'Database backup requested');
  return job;
}

/** Copy one collection to storage in chunk files. */
async function backUpCollection(db, name, backupId, chunkDocuments) {
  const collection = db.collection(name);
  const files = [];
  let documents = 0;
  let bytes = 0;
  let lines = [];

  async function writeChunk() {
    if (lines.length === 0) return;
    const body = gzipSync(Buffer.from(lines.join('\n')));
    const key = fileKey(backupId, name, files.length + 1);
    await uploadObject({ key, body, contentType: 'application/gzip' });
    files.push({ key, documents: lines.length });
    bytes += body.length;
    lines = [];
  }

  // Sorted by _id so the copy has a stable order.
  for await (const document of collection.find({}).sort({ _id: 1 })) {
    lines.push(EJSON.stringify(document, { relaxed: false }));
    documents += 1;
    if (lines.length >= chunkDocuments) await writeChunk();
  }
  await writeChunk();

  const indexes = (await collection.indexes()).filter((index) => index.name !== '_id_');
  return { name, documents, bytes, files, indexes };
}

/** The backups that are too old at a moment; the newest ones are never among them. */
function expiredAt(backups, moment) {
  const newestFirst = [...backups].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const cutoff = new Date(moment.getTime() - BACKUP_KEEP_DAYS * DAY_MS).toISOString();
  return newestFirst.filter(
    (backup, position) => position >= BACKUP_KEEP_AT_LEAST && backup.createdAt < cutoff,
  );
}

/** Delete old backups, always keeping the newest ones. Returns the ids that were deleted. */
async function pruneBackups(backups, now) {
  const newestFirst = [...backups].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const expired = expiredAt(backups, now);

  for (const backup of expired) {
    const manifest = await readJson(manifestKey(backup.id));
    const keys = (manifest?.collections ?? []).flatMap((collection) =>
      collection.files.map((file) => file.key),
    );
    for (const key of [...keys, manifestKey(backup.id)]) await deleteObject(key);
  }
  const expiredIds = expired.map((backup) => backup.id);
  return {
    kept: newestFirst.filter((backup) => !expiredIds.includes(backup.id)),
    deleted: expiredIds,
    expired,
  };
}

const formatDay = (value) =>
  new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'Asia/Kolkata' }).format(
    new Date(value),
  );

const formatTime = (value) =>
  new Intl.DateTimeFormat('en-IN', { timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(value);

/**
 * Tell the people who manage the settings (by default only the CEO) that old backups were
 * deleted, or will be at `deleteAt`. Decided from the permissions, not from a role's name.
 * @param {{ id: string, createdAt: string }[]} deleted
 * @param {{ deleteAt?: Date }} [options]  deleteAt: set for the warning before the deletion
 */
async function tellAboutDeletedBackups(deleted, { deleteAt } = {}) {
  if (deleted.length === 0) return;
  const roles = await Role.find({
    grants: { $elemMatch: { feature: 'settings', action: 'edit', scope: 'all' } },
  })
    .select('_id')
    .lean();
  const users = await User.find({
    roleId: { $in: roles.map((role) => role._id) },
    status: 'active',
  })
    .select('_id')
    .lean();
  const days = deleted.map((backup) => formatDay(backup.createdAt));
  const what =
    deleted.length === 1 ? 'An old database backup' : `${deleted.length} old database backups`;
  const title = deleteAt
    ? `${what} will be deleted at ${formatTime(deleteAt)}`
    : `${what} ${deleted.length === 1 ? 'was' : 'were'} deleted`;
  for (const user of users) {
    await notify({
      userId: user._id,
      type: 'backup_deleted',
      title,
      body: `Older than ${BACKUP_KEEP_DAYS} days: ${[...new Set(days)].join(', ')}`.slice(0, 300),
      link: '/settings?section=backups',
      dedupeKey: `backup-${deleteAt ? 'warning' : 'deleted'}:${deleted[0].id}:${user._id}`,
    });
  }
}

/**
 * Back up the whole database the app is connected to.
 * Safe to run twice: each run makes its own, complete backup.
 * @param {{ now?: Date, chunkDocuments?: number }} [options]  Only tests pass these
 * Old backups are not deleted here: that is the clean-up (runBackupCleanup), at its own time.
 * @returns {Promise<{ id: string, createdAt: string, documents: number, bytes: number,
 *                     collections: number }>}
 */
export async function createBackup({ now = new Date(), chunkDocuments } = {}) {
  const db = mongoose.connection.db;
  const createdAt = now.toISOString();
  // For example "2026-10-09T20-30-00Z": sorts by time and is safe as a folder name.
  const id = createdAt.replace(/\.\d{3}Z$/, 'Z').replaceAll(':', '-');

  const names = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((collection) => collection.name)
    .filter((name) => !name.startsWith('system.') && !BACKUP_SKIP_COLLECTIONS.includes(name))
    .sort();

  const collections = [];
  for (const name of names) {
    collections.push(
      await backUpCollection(db, name, id, chunkDocuments ?? BACKUP_CHUNK_DOCUMENTS),
    );
  }

  const summary = {
    id,
    createdAt,
    documents: collections.reduce((sum, collection) => sum + collection.documents, 0),
    bytes: collections.reduce((sum, collection) => sum + collection.bytes, 0),
    collections: collections.length,
  };
  // The manifest is written last: a backup without one is unfinished and is never offered.
  await uploadObject({
    key: manifestKey(id),
    body: toJsonBuffer({ ...summary, database: db.databaseName, format: 1, collections }),
    contentType: 'application/json',
  });

  await uploadObject({
    key: BACKUP_INDEX_KEY,
    body: toJsonBuffer({ backups: [summary, ...(await listBackups())] }),
    contentType: 'application/json',
  });

  logger.info(summary, 'Database backup finished');
  return summary;
}

// India time is UTC + 5:30, the whole year.
const INDIA_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** The India day of a moment, as "2026-10-12". */
const indiaDay = (moment) =>
  new Date(moment.getTime() + INDIA_OFFSET_MS).toISOString().slice(0, 10);
/** The moment of "HH:mm" India time on an India day. */
const indiaMoment = (day, time) => new Date(Date.parse(`${day}T${time}:00.000Z`) - INDIA_OFFSET_MS);

/** Do one of the two daily steps only once: true for the run that may do it. */
async function claimDay(field, day) {
  const result = await Settings.updateOne(
    { key: 'app', [`backups.${field}`]: { $ne: day } },
    { $set: { [`backups.${field}`]: day } },
  );
  return result.modifiedCount > 0;
}

/**
 * The clean-up, called every minute: at the delete time of Settings → Backups the backups older
 * than the keep time are deleted; the people who manage the settings are told that many minutes
 * before (or, with 0 minutes, at that moment). Each step is done once per day, also when the
 * server was down at the exact minute (it then happens at the next run of that day).
 * @param {{ now?: Date }} [options]  Only tests pass this
 * @returns {Promise<{ warned: string[], deleted: string[] }>} The ids of the backups
 */
export async function runBackupCleanup({ now = new Date() } = {}) {
  const done = { warned: [], deleted: [] };
  if (!isStorageConfigured()) return done;
  const settings = await readCleanupSettings();
  const today = indiaDay(now);

  // The warning: also for a delete time early tomorrow, when the warning falls on today.
  if (settings.notifyMinutesBefore > 0) {
    for (const day of [today, indiaDay(new Date(now.getTime() + DAY_MS))]) {
      const deleteAt = indiaMoment(day, settings.deleteTime);
      const warnAt = new Date(deleteAt.getTime() - settings.notifyMinutesBefore * 60 * 1000);
      if (now < warnAt || now >= deleteAt || settings.lastWarningDay === day) continue;
      if (!(await claimDay('lastWarningDay', day))) continue;
      const expired = expiredAt(await listBackups(), deleteAt);
      await tellAboutDeletedBackups(expired, { deleteAt });
      done.warned = expired.map((backup) => backup.id);
    }
  }

  const deleteAt = indiaMoment(today, settings.deleteTime);
  if (now >= deleteAt && settings.lastCleanupDay !== today) {
    if (await claimDay('lastCleanupDay', today)) {
      const { kept, deleted, expired } = await pruneBackups(await listBackups(), now);
      if (deleted.length > 0) {
        await uploadObject({
          key: BACKUP_INDEX_KEY,
          body: toJsonBuffer({ backups: kept }),
          contentType: 'application/json',
        });
        logger.info({ deleted }, 'Old database backups deleted');
        // Told before already, unless the setting says "at that moment".
        if (settings.notifyMinutesBefore === 0) await tellAboutDeletedBackups(expired);
      }
      done.deleted = deleted;
    }
  }
  return done;
}

/**
 * Copy a backup into another database on the same server, and check that every document arrived.
 * The target must be EMPTY and must not be the database the app is using: a restore never
 * overwrites live data. To put a restored copy into use, point the app at it.
 *
 * @param {{ backupId: string, targetDatabase: string }} input
 * @returns {Promise<{ backupId: string, targetDatabase: string, documents: number,
 *                     collections: { name: string, documents: number }[] }>}
 */
export async function restoreBackup({ backupId, targetDatabase }) {
  if (!/^[A-Za-z0-9_-]{1,38}$/.test(targetDatabase ?? '')) {
    throw badRequest('The target database name may use letters, digits, "_" and "-" only.');
  }
  if (!/^[0-9TZ-]{10,30}$/.test(backupId ?? '')) throw badRequest('Not a valid backup id.');
  if (targetDatabase === mongoose.connection.name) {
    throw conflict('A backup cannot be restored over the database the app is using.');
  }

  const manifest = await readJson(manifestKey(backupId));
  if (!manifest) throw notFound('This backup does not exist or was never finished.');

  const target = mongoose.connection.getClient().db(targetDatabase);
  if ((await target.listCollections({}, { nameOnly: true }).toArray()).length > 0) {
    throw conflict(`The database "${targetDatabase}" is not empty. Choose a new, empty one.`);
  }

  const restored = [];
  for (const collection of manifest.collections) {
    const targetCollection = target.collection(collection.name);
    // An empty collection has no files; creating it keeps the restored database complete.
    if (collection.files.length === 0) await target.createCollection(collection.name);

    for (const file of collection.files) {
      const buffer = await readObject(file.key);
      if (!buffer) throw notFound(`A file of this backup is missing: ${file.key}`);
      const documents = gunzipSync(buffer)
        .toString('utf8')
        .split('\n')
        .map((line) => EJSON.parse(line, { relaxed: false }));
      await targetCollection.insertMany(documents, { ordered: true });
    }

    for (const index of collection.indexes) {
      // "v" and "ns" describe the old database and must not be sent when creating the index.
      const options = Object.fromEntries(
        Object.entries(index).filter(([field]) => !['key', 'v', 'ns'].includes(field)),
      );
      await targetCollection.createIndex(index.key, options);
    }

    const documents = await targetCollection.countDocuments();
    if (documents !== collection.documents) {
      throw conflict(
        `Restore check failed for "${collection.name}": ${documents} documents arrived, ` +
          `${collection.documents} were in the backup.`,
      );
    }
    restored.push({ name: collection.name, documents });
  }

  const documents = restored.reduce((sum, collection) => sum + collection.documents, 0);
  logger.info({ backupId, targetDatabase, documents }, 'Backup restored and checked');
  return { backupId, targetDatabase, documents, collections: restored };
}
