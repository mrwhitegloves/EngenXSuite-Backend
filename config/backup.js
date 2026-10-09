// Settings of the nightly database backup, in one place.

// Where backups live in the storage bucket: backups/<backup id>/…
export const BACKUP_PREFIX = 'backups/';
// One small file that lists the finished backups (so no "list the bucket" permission is needed).
export const BACKUP_INDEX_KEY = `${BACKUP_PREFIX}index.json`;

// Every night at 02:00 India time.
export const BACKUP_CRON = '0 2 * * *';
export const BACKUP_TIMEZONE = 'Asia/Kolkata';

// Backups older than this are deleted, but the newest ones are always kept, so a long stretch
// of failed nights can never delete the last good backup.
export const BACKUP_KEEP_DAYS = 14;
export const BACKUP_KEEP_AT_LEAST = 7;

// The Backups screen warns when the newest backup is older than this.
export const BACKUP_STALE_DAYS = 2;

// A collection is written in files of this many documents, so memory use stays small however
// large a collection grows.
export const BACKUP_CHUNK_DOCUMENTS = 2000;

// Not backed up: sign-in sessions. After a restore everybody simply signs in again.
export const BACKUP_SKIP_COLLECTIONS = ['sessions'];
