import { JOB_NAMES } from '../constants/jobNames.js';
import { runBackup } from './backup.jobs.js';
import { runImportJob, runImportUndoJob } from './imports.jobs.js';
import { runPing } from './system.jobs.js';
import { runWebhookEvent, runWebhookSweep } from './webhooks.jobs.js';

// Every background job name and the function that runs it. A worker looks the name up here.
// To add a job: write the handler in `<feature>.jobs.js`, add its name to
// constants/jobNames.js and below, and add it with enqueue(queue, name, data) from a service.
//
// A handler receives (data, { jobId, attempt }). `data` holds ids only. A handler must be safe
// to run twice, because a job is tried again after a failure or a server restart.

export { JOB_NAMES };

export const JOB_HANDLERS = {
  [JOB_NAMES.systemPing]: runPing,
  [JOB_NAMES.databaseBackup]: runBackup,
  [JOB_NAMES.webhookProcess]: runWebhookEvent,
  [JOB_NAMES.webhookSweep]: runWebhookSweep,
  [JOB_NAMES.importRun]: runImportJob,
  [JOB_NAMES.importUndo]: runImportUndoJob,
};
