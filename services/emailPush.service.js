import { timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { JOB_NAMES } from '../constants/jobNames.js';
import { watchMailbox } from '../integrations/google/gmail.js';
import { logger } from '../infra/logger.js';
import { enqueue } from '../infra/queues.js';
import { UserGoogleConnection } from '../models/userGoogleConnection.model.js';
import { syncMailbox } from './emailSync.service.js';
import { getGoogleAccessToken } from './googleConnection.service.js';
import { registerWebhookProcessor } from './webhooks.service.js';

// Push from Gmail: Google tells us at once that a mailbox changed, instead of us asking every
// three minutes (docs/EMAIL.md, "Push from Gmail").
//
//   1. For each connected mailbox we ask Gmail to "watch" it and to publish every change to a
//      Google Pub/Sub topic (GMAIL_PUSH_TOPIC). A watch runs out after seven days, so a job
//      renews it.
//   2. A Pub/Sub push subscription calls our webhook, with a secret in its address
//      (GMAIL_PUSH_TOKEN). The message says only WHICH mailbox changed: no mail is in it.
//   3. We then read that mailbox the normal way (services/emailSync.service.js).
//
// Optional: without the two settings nothing here runs, and the reading every three minutes
// goes on as before. That reading also stays on WITH push, so a lost message is caught up.

const DAY_MS = 24 * 60 * 60 * 1000;
// Renewed when less than this is left.
const RENEW_WHEN_LEFT_MS = 2 * DAY_MS;

export const isGmailPushConfigured = () => Boolean(env.GMAIL_PUSH_TOPIC && env.GMAIL_PUSH_TOKEN);

/** The check of the webhook: the secret in the address is ours. */
export function isValidGmailPushToken(token) {
  if (!isGmailPushConfigured() || typeof token !== 'string') return false;
  const given = Buffer.from(token);
  const ours = Buffer.from(env.GMAIL_PUSH_TOKEN);
  return given.length === ours.length && timingSafeEqual(given, ours);
}

/** What Pub/Sub sent, as we keep it: which mailbox, and its point of history. */
export function readGmailPush(body) {
  try {
    const data = JSON.parse(Buffer.from(String(body?.message?.data ?? ''), 'base64').toString());
    return {
      emailAddress: String(data.emailAddress ?? '').toLowerCase(),
      historyId: String(data.historyId ?? ''),
    };
  } catch {
    return {};
  }
}

/**
 * Start or renew the watch of every connected mailbox that needs it. A background job calls
 * this every hour; a mailbox that was connected a moment ago is watched within the hour.
 * @param {Date} [now]  Only tests pass it
 */
export async function renewGmailWatches(now = new Date()) {
  if (!isGmailPushConfigured()) return { skipped: 'not set up' };
  const due = await UserGoogleConnection.find({
    status: 'connected',
    $or: [
      { 'gmail.watchExpiresAt': null },
      { 'gmail.watchExpiresAt': { $lt: new Date(now.getTime() + RENEW_WHEN_LEFT_MS) } },
    ],
  })
    .select('userId')
    .limit(200)
    .lean();
  let watched = 0;
  for (const connection of due) {
    try {
      const token = await getGoogleAccessToken(connection.userId);
      const { expiresAt } = await watchMailbox(token, env.GMAIL_PUSH_TOPIC);
      await UserGoogleConnection.updateOne(
        { _id: connection._id },
        { $set: { 'gmail.watchExpiresAt': expiresAt } },
      );
      watched += 1;
    } catch (error) {
      // One mailbox that cannot be watched must not stop the others; it is still read by time.
      logger.warn({ err: error, userId: String(connection.userId) }, 'Gmail watch failed');
    }
  }
  return { watched };
}

/** A mailbox changed: read it now. */
async function processGmailPush(event) {
  const address = event.payload?.emailAddress;
  const connection = address
    ? await UserGoogleConnection.findOne({ googleEmail: address, status: 'connected' })
        .select('userId')
        .lean()
    : null;
  if (!connection) return;
  const userId = String(connection.userId);
  try {
    // Several messages within a few seconds are one reading.
    await enqueue(
      'messaging',
      JOB_NAMES.emailSync,
      { userId },
      { jobId: `email-sync-${userId}-${Math.floor(Date.now() / 10_000)}` },
    );
  } catch {
    await syncMailbox(userId);
  }
}
registerWebhookProcessor('gmail_push', processGmailPush);
