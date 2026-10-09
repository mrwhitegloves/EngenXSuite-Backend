import { Queue } from 'bullmq';
import { env } from '../config/env.js';
import {
  BACKOFF_DELAY_MS,
  KEEP_COMPLETED,
  KEEP_FAILED,
  QUEUE_NAMES,
  QUEUE_SETTINGS,
} from '../config/queues.js';
import { createAppError, notFound } from '../lib/errors.js';
import { createQueueConnection, getRedis } from './redis.js';

// Background jobs (BullMQ on Redis). This file adds jobs and reads their state; infra/workers.js
// runs them. Rules (Master Prompt Section 75):
//   - job data holds ids only, never whole records, never secrets
//   - every job must be safe to run twice
//   - when Redis is down, adding a job fails with a clear message (the rest of the app works)

// Development and production never share jobs, even if they share one Redis.
export const QUEUE_PREFIX = `queue:${env.NODE_ENV}`;

let connection = null;
const queues = new Map();

const unavailable = () =>
  createAppError(
    'QUEUE_UNAVAILABLE',
    503,
    'Background work is not available right now. Please try again in a few minutes.',
  );

/** The queue object, created on first use. Throws the 503 error when Redis is not usable. */
function getQueue(queueName) {
  if (!QUEUE_NAMES.includes(queueName)) throw new Error(`Unknown queue "${queueName}"`);
  if (!getRedis()) throw unavailable();
  if (!connection) connection = createQueueConnection('producer');
  if (!connection) throw unavailable();

  if (!queues.has(queueName)) {
    // Queue is the library's class; one is created per queue name, here.
    const queue = new Queue(queueName, {
      connection,
      prefix: QUEUE_PREFIX,
      defaultJobOptions: {
        attempts: QUEUE_SETTINGS[queueName].attempts,
        backoff: { type: 'exponential', delay: BACKOFF_DELAY_MS },
        removeOnComplete: KEEP_COMPLETED,
        removeOnFail: KEEP_FAILED,
      },
    });
    queue.on('error', () => {
      // Connection problems are logged once by infra/redis.js.
    });
    queues.set(queueName, queue);
  }
  return queues.get(queueName);
}

/** Run a queue call; any Redis problem becomes the clear 503 error. */
async function withQueue(queueName, action) {
  const queue = getQueue(queueName);
  try {
    return await action(queue);
  } catch (error) {
    if (error?.isAppError) throw error;
    throw unavailable();
  }
}

/**
 * Add a job.
 * @param {string} queueName  one of QUEUE_NAMES
 * @param {string} jobName    a name registered in jobs/index.js
 * @param {object} data       ids only
 * @param {{ jobId?: string, delayMs?: number }} [options]
 *        jobId: the same id is added only once while that job still exists (prevents duplicates)
 * @returns {Promise<{ id: string }>}
 */
export function enqueue(queueName, jobName, data = {}, options = {}) {
  return withQueue(queueName, async (queue) => {
    const job = await queue.add(jobName, data, {
      ...(options.jobId ? { jobId: options.jobId } : {}),
      ...(options.delayMs ? { delay: options.delayMs } : {}),
    });
    return { id: String(job.id) };
  });
}

/**
 * Run a job by the clock. The same `id` replaces an earlier schedule, so calling this at every
 * server start never creates a second copy.
 * @param {{ id: string, queue: string, cron: string, timezone: string, jobName: string }} schedule
 */
export function scheduleRepeatingJob({ id, queue: queueName, cron, timezone, jobName }) {
  return withQueue(queueName, async (queue) => {
    await queue.upsertJobScheduler(
      id,
      { pattern: cron, tz: timezone },
      { name: jobName, data: {} },
    );
  });
}

/** How many jobs each queue holds in each state. Queues that cannot be read report nulls. */
export async function getQueueCounts() {
  return Promise.all(
    QUEUE_NAMES.map(async (name) => {
      try {
        const counts = await withQueue(name, (queue) =>
          queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'),
        );
        return { name, available: true, ...counts };
      } catch {
        return { name, available: false };
      }
    }),
  );
}

function toJobView(job) {
  return {
    id: String(job.id),
    name: job.name,
    data: job.data,
    failedReason: job.failedReason ?? null,
    attemptsMade: job.attemptsMade,
    createdAt: job.timestamp ? new Date(job.timestamp).toISOString() : null,
    failedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
  };
}

/** Failed jobs of one queue, newest first. */
export function listFailedJobs(queueName, { page = 1, pageSize = 25 } = {}) {
  return withQueue(queueName, async (queue) => {
    const start = (page - 1) * pageSize;
    const [jobs, total] = await Promise.all([
      queue.getFailed(start, start + pageSize - 1),
      queue.getFailedCount(),
    ]);
    return { items: jobs.filter(Boolean).map(toJobView), total, page, pageSize };
  });
}

async function getFailedJob(queue, jobId) {
  const job = await queue.getJob(jobId);
  if (!job || !(await job.isFailed())) throw notFound('This failed job no longer exists');
  return job;
}

/** Put a failed job back in the queue so that it runs again. */
export function retryFailedJob(queueName, jobId) {
  return withQueue(queueName, async (queue) => {
    const job = await getFailedJob(queue, jobId);
    await job.retry('failed');
    return toJobView(job);
  });
}

/** Delete a failed job for good. */
export function removeFailedJob(queueName, jobId) {
  return withQueue(queueName, async (queue) => {
    const job = await getFailedJob(queue, jobId);
    const view = toJobView(job);
    await job.remove();
    return view;
  });
}

export async function closeQueues() {
  await Promise.all([...queues.values()].map((queue) => queue.close().catch(() => {})));
  queues.clear();
  if (connection) await connection.quit().catch(() => {});
  connection = null;
}
