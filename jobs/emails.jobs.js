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
 * Bring one person's mailbox up to date. Safe to run twice: one run at a time per mailbox, and
 * a message is stored once.
 * @param {{ userId: string }} data
 */
export async function runEmailSyncJob({ userId }) {
  return syncMailbox(userId);
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
