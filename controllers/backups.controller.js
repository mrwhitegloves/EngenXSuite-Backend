import {
  getBackupsOverview,
  requestBackup,
  updateBackupCleanup,
} from '../services/backup.service.js';
import { sendCreated, sendOk } from '../lib/respond.js';

// GET /api/backups: the finished database backups, newest first.
export async function getBackups(req, res) {
  sendOk(res, await getBackupsOverview());
}

// POST /api/backups: start a backup now, as a background job.
export async function postBackup(req, res) {
  sendCreated(res, await requestBackup(req.user));
}

// PATCH /api/backups/cleanup: when old backups are deleted, and how long before people are told.
export async function patchCleanup(req, res) {
  sendOk(res, await updateBackupCleanup(req.user, req.validated.body, { requestId: req.id }));
}
