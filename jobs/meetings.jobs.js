import { JOB_NAMES } from '../constants/jobNames.js';
import { enqueue } from '../infra/queues.js';
import { syncCalendar } from '../services/calendarSync.service.js';
import { connectedUserIds } from '../services/emailSync.service.js';
import { runMeetingReminders } from '../services/meetings.service.js';

/** Every minute: remind our people of meetings that start within half an hour. */
export async function runMeetingRemindersJob() {
  return runMeetingReminders();
}

/**
 * Bring the company calendar's changes into the CRM. Safe to run twice: an event is one
 * meeting, and an unchanged event changes nothing.
 */
export async function runCalendarSyncJob() {
  return syncCalendar();
}

/** Every few minutes: one sync job per connected calendar. */
export async function runCalendarSyncAllJob() {
  const userIds = await connectedUserIds();
  const slot = Math.floor(Date.now() / 60_000);
  for (const userId of userIds) {
    await enqueue(
      'integrations',
      JOB_NAMES.calendarSync,
      { userId },
      { jobId: `calendar-sync-${userId}-${slot}` },
    );
  }
  return { calendars: userIds.length };
}
