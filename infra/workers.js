import { UnrecoverableError, Worker } from 'bullmq';
import { QUEUE_NAMES, QUEUE_SETTINGS } from '../config/queues.js';
import { logger } from './logger.js';
import { QUEUE_PREFIX } from './queues.js';
import { createQueueConnection } from './redis.js';
import { reportError } from './sentry.js';

// Runs the background jobs inside this same server process (one deployable, Section 75).
// A job is: a name + a small data object of ids. The handler for each name is in jobs/index.js.

let connection = null;
let workers = [];

/**
 * What a worker does with one job: find the handler by the job's name and call it with the data.
 * Exported so that tests can run it without Redis.
 */
export function createProcessor(handlers) {
  return async function processJob(job) {
    const handler = handlers[job.name];
    if (!handler) {
      // Retrying cannot help when no code exists for this job name.
      throw new UnrecoverableError(`No handler is registered for the job "${job.name}"`);
    }
    return handler(job.data, { jobId: String(job.id), attempt: job.attemptsMade + 1 });
  };
}

/** True when this failure was the last attempt, so the job now sits in the failed list. */
export function isFinalFailure(job, error) {
  if (!job) return true;
  if (error?.name === 'UnrecoverableError') return true;
  return job.attemptsMade >= (job.opts?.attempts ?? 1);
}

/** Start one worker per queue. Does nothing when Redis is not configured. */
export function startWorkers(handlers) {
  if (workers.length) return;
  connection = createQueueConnection('worker');
  if (!connection) {
    logger.info('Background jobs are off: REDIS_URL is not set');
    return;
  }

  const processJob = createProcessor(handlers);
  workers = QUEUE_NAMES.map((queueName) => {
    // Worker is the library's class; one is created per queue, here.
    const worker = new Worker(queueName, processJob, {
      connection,
      prefix: QUEUE_PREFIX,
      concurrency: QUEUE_SETTINGS[queueName].concurrency,
    });

    worker.on('failed', (job, error) => {
      const details = { queue: queueName, job: job?.name, jobId: job?.id, err: error };
      if (isFinalFailure(job, error)) {
        logger.error(details, 'Background job failed and will not be tried again');
        reportError(error, { path: `job:${queueName}/${job?.name}` });
      } else {
        logger.warn(details, 'Background job failed and will be tried again');
      }
    });
    worker.on('error', () => {
      // Connection problems are logged once by infra/redis.js.
    });
    return worker;
  });
  logger.info({ queues: QUEUE_NAMES }, 'Background job workers started');
}

/** Let running jobs finish, then stop. */
export async function stopWorkers() {
  await Promise.all(workers.map((worker) => worker.close().catch(() => {})));
  workers = [];
  if (connection) await connection.quit().catch(() => {});
  connection = null;
}
