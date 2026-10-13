// The name of every background job. Services use a name to add a job; jobs/index.js maps each
// name to the function that runs it.

export const JOB_NAMES = {
  systemPing: 'system.ping',
  databaseBackup: 'backup.database',
  backupCleanup: 'backup.cleanup',
  webhookProcess: 'webhook.process',
  webhookSweep: 'webhook.sweep',
  importRun: 'import.run',
  importUndo: 'import.undo',
  taskReminders: 'tasks.reminders',
  insightRefresh: 'ai.insight-refresh',
  insightDaily: 'ai.insight-daily',
  emailSync: 'email.sync',
  emailSyncAll: 'email.sync-all',
  emailFollowUps: 'email.follow-ups',
  emailWatchRenew: 'email.watch-renew',
  calendarSync: 'calendar.sync',
  calendarSyncAll: 'calendar.sync-all',
  meetingReminders: 'meetings.reminders',
};
