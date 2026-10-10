import { BACKUP_CRON, BACKUP_TIMEZONE } from '../config/backup.js';
import { env } from '../config/env.js';
import { logger } from '../infra/logger.js';
import { scheduleRepeatingJob } from '../infra/queues.js';
import { isStorageConfigured } from '../infra/storage.js';
import { JOB_NAMES } from '../constants/jobNames.js';

// Jobs that run by the clock. Each entry: which queue, a fixed id, when, and which job.
// Registering is safe to repeat: the same id replaces the earlier schedule, it never doubles it.
const SCHEDULES = [
  {
    id: 'nightly-database-backup',
    queue: 'integrations',
    cron: BACKUP_CRON,
    timezone: BACKUP_TIMEZONE,
    jobName: JOB_NAMES.databaseBackup,
    // Needs somewhere to put the backup.
    isEnabled: () => isStorageConfigured(),
  },
  {
    // Every 5 minutes: queue webhook events that were stored while the queue was not available.
    id: 'webhook-sweep',
    queue: 'webhooks',
    cron: '*/5 * * * *',
    timezone: 'Asia/Kolkata',
    jobName: JOB_NAMES.webhookSweep,
    isEnabled: () => true,
  },
  {
    // Every minute: task reminders and "overdue" notifications.
    id: 'task-reminders',
    queue: 'messaging',
    cron: '* * * * *',
    timezone: 'Asia/Kolkata',
    jobName: JOB_NAMES.taskReminders,
    isEnabled: () => true,
  },
];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Register the schedules. Only the production server does this: a developer's laptop must not
 * run nightly jobs. (Any job can still be started by hand in development.)
 *
 * Redis connects in the background, so right after startup it may not be ready: each schedule
 * is tried a few times. Never throws: if Redis stays away, the schedule stored in Redis by the
 * last start keeps working.
 * @param {{ attempts?: number, waitMs?: number, force?: boolean }} [options]  Only tests pass these
 */
export async function registerSchedules({ attempts = 10, waitMs = 3000, force = false } = {}) {
  if (env.NODE_ENV !== 'production' && !force) return;
  for (const schedule of SCHEDULES.filter((item) => item.isEnabled())) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await scheduleRepeatingJob(schedule);
        logger.info({ schedule: schedule.id, cron: schedule.cron }, 'Scheduled job registered');
        break;
      } catch (error) {
        if (attempt === attempts) {
          logger.warn({ err: error, schedule: schedule.id }, 'Scheduled job was not registered');
        } else {
          await wait(waitMs);
        }
      }
    }
  }
}
