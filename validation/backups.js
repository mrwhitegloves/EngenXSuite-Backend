import { z } from 'zod';
import { BACKUP_NOTIFY_MINUTES_MAX } from '../config/backup.js';

export const backupCleanupBody = z
  .object({
    // India time, 24-hour: "02:30".
    deleteTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Enter a time like 02:30'),
    // 0 = told at the moment the backups are deleted.
    notifyMinutesBefore: z.number().int().min(0).max(BACKUP_NOTIFY_MINUTES_MAX),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });
