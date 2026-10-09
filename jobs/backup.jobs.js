import { createBackup } from '../services/backup.service.js';

/**
 * The nightly database backup (also started by hand from Settings → Backups).
 * Safe to run twice: a second run simply makes one more complete backup.
 */
export async function runBackup() {
  const { id, documents, bytes } = await createBackup();
  return { id, documents, bytes };
}
