import { JOB_NAMES } from '../constants/jobNames.js';
import { enqueue } from '../infra/queues.js';
import { runFollowUpReminders } from '../services/emailAssist.service.js';
import { renewGmailWatches } from '../services/emailPush.service.js';
import { connectedUserIds, syncMailbox } from '../services/emailSync.service.js';

/** Every hour: start or renew the Gmail watch of the mailboxes that need it. */
export async function runEmailWatchRenewJob() {
  return renewGmailWatches();
}

/** Every morning: tell people about mails of theirs that got no answer for 3 or 7 days. */
export async function runEmailFollowUpsJob() {
  return runFollowUpReminders();
}

/**
 * Bring the company mailbox up to date. Safe to run twice: one run at a time, and a message is
 * stored once. (The job data still carries the mailbox's user id; it is not needed.)
 */
export async function runEmailSyncJob() {
  return syncMailbox();
}

/** Every few minutes: one sync job per connected mailbox. */
export async function runEmailSyncAllJob() {
  const userIds = await connectedUserIds();
  const slot = Math.floor(Date.now() / 60_000);
  for (const userId of userIds) {
    await enqueue(
      'messaging',
      JOB_NAMES.emailSync,
      { userId },
      { jobId: `email-sync-${userId}-${slot}` },
    );
  }
  return { mailboxes: userIds.length };
}
