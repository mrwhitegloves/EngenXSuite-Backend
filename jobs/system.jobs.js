import { logger } from '../infra/logger.js';

// Jobs that belong to the system itself, not to a CRM feature.

/**
 * The test job behind "Send a test job" in Settings → Background jobs. It proves the whole path
 * works: add to Redis → worker picks it up → handler runs. `shouldFail` makes it fail on purpose,
 * to see a failed job and try the Retry button.
 * Safe to run twice: it only writes a log line.
 */
export async function runPing({ requestedBy, shouldFail = false }, { jobId, attempt }) {
  if (shouldFail) throw new Error('This test job was asked to fail');
  logger.info({ jobId, attempt, requestedBy }, 'Test job ran');
  return { ok: true };
}
