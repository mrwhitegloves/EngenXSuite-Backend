import { processWebhookEvent, requeueWaitingWebhooks } from '../services/webhooks.service.js';

/** Handle one stored webhook event. Safe to run twice: a handled event is left alone. */
export async function runWebhookEvent({ webhookEventId }) {
  return { result: await processWebhookEvent(webhookEventId) };
}

/** Queue stored events that never reached the queue. Safe to run twice. */
export async function runWebhookSweep() {
  return { queued: await requeueWaitingWebhooks() };
}
