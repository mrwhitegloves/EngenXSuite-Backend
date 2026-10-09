// The name of every background job. Services use a name to add a job; jobs/index.js maps each
// name to the function that runs it.

export const JOB_NAMES = {
  systemPing: 'system.ping',
  databaseBackup: 'backup.database',
  webhookProcess: 'webhook.process',
  webhookSweep: 'webhook.sweep',
};
