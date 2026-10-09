// The four background-job queues (Master Prompt Section 75) and their settings, in one place.
//   concurrency : how many jobs of this queue run at the same time in this server
//   attempts    : how many times a job is tried before it is marked as failed
// Between attempts the wait doubles each time, starting at BACKOFF_DELAY_MS.

export const QUEUE_SETTINGS = {
  ai: { concurrency: 2, attempts: 3 },
  messaging: { concurrency: 3, attempts: 3 },
  integrations: { concurrency: 2, attempts: 3 },
  webhooks: { concurrency: 5, attempts: 5 },
};

export const QUEUE_NAMES = Object.keys(QUEUE_SETTINGS);

export const BACKOFF_DELAY_MS = 5_000;

// Redis is small, so finished jobs are not kept for long. Failed jobs stay longer, so that
// someone can look at them and retry them from Settings → Background jobs.
export const KEEP_COMPLETED = { age: 60 * 60, count: 200 };
export const KEEP_FAILED = { age: 14 * 24 * 60 * 60, count: 500 };
