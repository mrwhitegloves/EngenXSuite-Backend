import { getBackupsOverview, requestBackup } from '../services/backup.service.js';
import { sendCreated, sendOk } from '../lib/respond.js';

// GET /api/backups: the finished database backups, newest first.
export async function getBackups(req, res) {
  sendOk(res, await getBackupsOverview());
}

// POST /api/backups: start a backup now, as a background job.
export async function postBackup(req, res) {
  sendCreated(res, await requestBackup(req.user));
}
