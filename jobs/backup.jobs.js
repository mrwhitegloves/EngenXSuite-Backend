import { createBackup, runBackupCleanup } from '../services/backup.service.js';

/**
 * The nightly database backup (also started by hand from Settings → Backups).
 * Safe to run twice: a second run simply makes one more complete backup.
 */
export async function runBackup() {
  const { id, documents, bytes } = await createBackup();
  return { id, documents, bytes };
}

/**
 * Every minute: at the times set in Settings → Backups, warn about and delete old backups.
 * Safe to run twice: each of the two is done once per day.
 */
export async function runBackupCleanupJob() {
  return runBackupCleanup();
}
