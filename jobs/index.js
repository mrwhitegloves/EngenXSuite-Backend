import { runPing } from './system.jobs.js';

// Every background job name and the function that runs it. A worker looks the name up here.
// To add a job: write the handler in `<feature>.jobs.js`, add its name below, and add it with
// enqueue(queue, name, data) from a service.
//
// A handler receives (data, { jobId, attempt }). `data` holds ids only. A handler must be safe
// to run twice, because a job is tried again after a failure or a server restart.

export const JOB_NAMES = {
  systemPing: 'system.ping',
};

export const JOB_HANDLERS = {
  [JOB_NAMES.systemPing]: runPing,
};
