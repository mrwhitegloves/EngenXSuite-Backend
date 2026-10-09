import { logger } from '../infra/logger.js';
import {
  enqueue,
  getQueueCounts,
  listFailedJobs,
  removeFailedJob,
  retryFailedJob,
} from '../infra/queues.js';
import { getRedisStatus } from '../infra/redis.js';
import { JOB_NAMES } from '../jobs/index.js';

// Settings → Background jobs: see what the queues hold, look at failed jobs, retry or delete them.
// Retry and delete are written to the log with who did it. They are not in the audit log: that
// records changes to CRM records, and a job is not one.

/** Queue totals, and whether Redis (which the queues live in) is reachable. */
export async function getJobsOverview() {
  return { redis: getRedisStatus(), queues: await getQueueCounts() };
}

export function listFailed(queueName, paging) {
  return listFailedJobs(queueName, paging);
}

export async function retryJob(actor, queueName, jobId) {
  const job = await retryFailedJob(queueName, jobId);
  logger.info(
    { userId: String(actor._id), queue: queueName, jobId, job: job.name },
    'Failed job retried',
  );
  return job;
}

export async function deleteJob(actor, queueName, jobId) {
  const job = await removeFailedJob(queueName, jobId);
  logger.info(
    { userId: String(actor._id), queue: queueName, jobId, job: job.name },
    'Failed job deleted',
  );
}

/** Add the harmless test job, to check that background work runs end to end. */
export function sendTestJob(actor, { shouldFail = false } = {}) {
  return enqueue('integrations', JOB_NAMES.systemPing, {
    requestedBy: String(actor._id),
    shouldFail,
  });
}
