import { JOB_NAMES } from '../constants/jobNames.js';
import { logger } from '../infra/logger.js';
import { enqueue } from '../infra/queues.js';
import { WebhookEvent } from '../models/webhookEvent.model.js';

// The one path every incoming webhook takes (Master Prompt Sections 51 and 75):
//   verify the signature → store the event → answer the provider at once → handle it in a
//   background job. Each provider's phase adds only its route, its signature check and its
//   processor; this file does not change.

const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_VALID_DAYS = 90;
// Requests that fail the signature check are kept for one day, without their body, only so that
// a wrong secret or a wrong address can be noticed.
const KEEP_INVALID_DAYS = 1;

// provider → async (event) => void. Filled by each provider's phase through the function below.
const processors = new Map();

/** Tell the receiver what to do with the events of one provider. */
export function registerWebhookProcessor(provider, processor) {
  processors.set(provider, processor);
}

/** Put the event on the queue. False when the queue is not available right now. */
async function queueEvent(eventId) {
  try {
    // The job id makes a second "queue this event" a no-op while the first is still there.
    await enqueue(
      'webhooks',
      JOB_NAMES.webhookProcess,
      { webhookEventId: String(eventId) },
      { jobId: `webhook-${eventId}` },
    );
    await WebhookEvent.updateOne(
      { _id: eventId, status: 'received' },
      { $set: { status: 'queued' } },
    );
    return true;
  } catch (error) {
    // Redis is down: the event is safe in the database and is picked up by the sweep job.
    logger.warn({ err: error, eventId: String(eventId) }, 'Webhook stored but not queued yet');
    return false;
  }
}

/**
 * Store an incoming webhook and queue it.
 * @param {{ provider: string, eventId: string, payload: unknown, signatureValid: boolean,
 *           now?: Date }} input
 * @returns {Promise<{ accepted: boolean, duplicate: boolean }>}
 *          accepted false: the signature was wrong; answer the sender with an error.
 *          duplicate true: this event was received before; answer "ok" and do nothing more.
 */
export async function receiveWebhook({
  provider,
  eventId,
  payload,
  signatureValid,
  now = new Date(),
}) {
  const keepDays = signatureValid ? KEEP_VALID_DAYS : KEEP_INVALID_DAYS;
  let event;
  try {
    event = await WebhookEvent.create({
      provider,
      // Kept apart, so that a forged request can never block the real event with the same id.
      eventId: signatureValid ? eventId : `invalid:${now.getTime()}:${eventId}`.slice(0, 200),
      payload: signatureValid ? (payload ?? {}) : { note: 'Body not stored: signature invalid' },
      signatureValid,
      status: signatureValid ? 'received' : 'ignored',
      expiresAt: new Date(now.getTime() + keepDays * DAY_MS),
    });
  } catch (error) {
    // The unique index (provider + eventId) refused it: the provider sent this event again.
    if (error?.code === 11000) return { accepted: signatureValid, duplicate: true };
    throw error;
  }

  if (!signatureValid) return { accepted: false, duplicate: false };
  await queueEvent(event._id);
  return { accepted: true, duplicate: false };
}

/**
 * Handle one stored event (the background job). Safe to run twice: an event that is already
 * processed or ignored is left alone.
 * @returns {Promise<'processed' | 'ignored' | 'missing'>}
 */
export async function processWebhookEvent(webhookEventId) {
  const event = await WebhookEvent.findById(webhookEventId).lean();
  if (!event) return 'missing';
  if (event.status === 'processed' || event.status === 'ignored') return event.status;

  const processor = event.signatureValid ? processors.get(event.provider) : null;
  if (!processor) {
    await WebhookEvent.updateOne(
      { _id: event._id },
      { $set: { status: 'ignored', error: 'No processor for this provider yet' } },
    );
    return 'ignored';
  }

  try {
    await processor(event);
  } catch (error) {
    await WebhookEvent.updateOne(
      { _id: event._id },
      {
        $set: { status: 'failed', error: String(error?.message ?? error).slice(0, 500) },
        $inc: { attempts: 1 },
      },
    );
    // Passed on, so the queue tries the job again (and reports the last failure).
    throw error;
  }

  await WebhookEvent.updateOne(
    { _id: event._id },
    {
      $set: { status: 'processed', processedAt: new Date() },
      $unset: { error: '' },
      $inc: { attempts: 1 },
    },
  );
  return 'processed';
}

/**
 * Queue the events that are stored but were never queued (Redis was down when they arrived),
 * and those queued long ago whose job was lost. Run every few minutes by a scheduled job.
 * @returns {Promise<number>} How many were queued now
 */
export async function requeueWaitingWebhooks({ now = new Date(), limit = 200 } = {}) {
  const waiting = await WebhookEvent.find({
    signatureValid: true,
    $or: [
      { status: 'received', createdAt: { $lt: new Date(now.getTime() - 60 * 1000) } },
      { status: 'queued', updatedAt: { $lt: new Date(now.getTime() - 30 * 60 * 1000) } },
    ],
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .select('_id')
    .lean();

  let queued = 0;
  for (const event of waiting) {
    if (await queueEvent(event._id)) queued += 1;
    else break; // the queue is still not available; try again at the next sweep
  }
  return queued;
}
