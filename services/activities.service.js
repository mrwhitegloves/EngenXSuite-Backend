import { JOB_NAMES } from '../constants/jobNames.js';
import { SOCKET_EVENTS } from '../constants/socketEvents.js';
import { logger } from '../infra/logger.js';
import { enqueue } from '../infra/queues.js';
import { emitToAll } from '../infra/realtime.js';
import { Account } from '../models/account.model.js';
import { Activity } from '../models/activity.model.js';
import { Contact } from '../models/contact.model.js';
import { Opportunity } from '../models/opportunity.model.js';

// THE writer of the timeline. Every module that wants an entry on the timeline (a note, a
// stage change, a task, later a call or an email) calls recordActivity(); no other code writes
// the `activities` collection. Reading the timeline is in services/timeline.service.js.
//
// This file imports models only, so every service can import it without a circle.

// A conversation with the customer: these also move the contact's "last talked to" time.
const INTERACTION_TYPES = ['CALL', 'EMAIL', 'WHATSAPP', 'MEETING', 'VOICE_NOTE'];

/**
 * Add one entry to the timeline.
 *
 * - At least one of accountId, contactId and opportunityId is needed. For a lead or a contact
 *   the company is filled in, so the entry also shows on the company's timeline.
 * - With `refCollection` + `refId` (+ `subtype`) the same event is written once only: a second
 *   call returns the entry that is there already. Writers that may run twice (jobs, webhooks)
 *   always pass them.
 * - The saved "last activity" times on the company, the lead and the contact are moved forward.
 *
 * @param {{ type: string, title: string, subtype?: string, direction?: string,
 *           accountId?: unknown, plantId?: unknown, contactId?: unknown, opportunityId?: unknown,
 *           userId?: unknown, occurredAt?: Date, content?: string, status?: string,
 *           refCollection?: string, refId?: unknown, metadata?: object }} entry
 * @returns {Promise<object>} The saved entry (plain object)
 */
export async function recordActivity(entry) {
  const links = { ...entry };
  if (!links.accountId && links.opportunityId) {
    links.accountId = (
      await Opportunity.findById(links.opportunityId).select('accountId').lean()
    )?.accountId;
  }
  if (!links.accountId && links.contactId) {
    links.accountId = (
      await Contact.findById(links.contactId).select('accountId').lean()
    )?.accountId;
  }
  if (!links.accountId && !links.contactId && !links.opportunityId) {
    throw new Error('A timeline entry needs a company, a contact or a lead');
  }

  const occurredAt = links.occurredAt ?? new Date();
  let activity;
  try {
    activity = await Activity.create({ ...links, occurredAt });
  } catch (error) {
    // The unique index: this event of this record is on the timeline already.
    if (error?.code === 11000 && links.refId) {
      return Activity.findOne({
        refCollection: links.refCollection,
        refId: links.refId,
        subtype: links.subtype,
      }).lean();
    }
    throw error;
  }

  // $max: an entry about something older never moves the time back.
  const touch = { $max: { lastActivityAt: occurredAt } };
  await Promise.all([
    links.accountId && Account.updateOne({ _id: links.accountId }, touch, { timestamps: false }),
    links.opportunityId &&
      Opportunity.updateOne({ _id: links.opportunityId }, touch, { timestamps: false }),
    links.contactId &&
      INTERACTION_TYPES.includes(links.type) &&
      Contact.updateOne(
        { _id: links.contactId },
        { $max: { lastInteractionAt: occurredAt } },
        { timestamps: false },
      ),
  ]);
  emitToAll(SOCKET_EVENTS.activitiesChanged);
  requestInsightRefresh(links);
  return activity.toObject();
}

// One refresh per record and half hour at most, a few minutes after the news (more may follow).
const INSIGHT_REFRESH_BUCKET_MS = 30 * 60 * 1000;
const INSIGHT_REFRESH_DELAY_MS = 5 * 60 * 1000;

/**
 * News on a record: its AI insights (when it has any) are refreshed by a background job. Only
 * ids go into the job; whether anything is done is decided there. Without a queue nothing
 * happens, and the insight simply shows "the records changed since this was written".
 */
function requestInsightRefresh({ opportunityId, accountId }) {
  const bucket = Math.floor(Date.now() / INSIGHT_REFRESH_BUCKET_MS);
  const targets = [
    opportunityId && ['lead', opportunityId],
    accountId && ['account', accountId],
  ].filter(Boolean);
  for (const [kind, id] of targets) {
    Promise.resolve()
      .then(() =>
        enqueue(
          'ai',
          JOB_NAMES.insightRefresh,
          { kind, id: String(id) },
          { jobId: `insight-${kind}-${id}-${bucket}`, delayMs: INSIGHT_REFRESH_DELAY_MS },
        ),
      )
      .catch(() => {});
  }
}

/**
 * Put an entry that a record wrote (found by its ref) on other records: a call that was matched
 * to the wrong person, or to nobody. With no record left to show it on, the entry is removed.
 * @param {{ refCollection: string, refId: unknown, subtype?: string }} ref
 * @param {{ accountId?: unknown, contactId?: unknown, opportunityId?: unknown, title: string }} links
 * @returns {Promise<boolean>} false when there was no such entry
 */
export async function relinkActivity(ref, { accountId, contactId, opportunityId, title }) {
  const filter = { refCollection: ref.refCollection, refId: ref.refId, subtype: ref.subtype };
  let found;
  if (!accountId && !contactId && !opportunityId) {
    found = (await Activity.deleteOne(filter)).deletedCount > 0;
  } else {
    const fields = { accountId, contactId, opportunityId };
    const set = Object.fromEntries(Object.entries(fields).filter(([, value]) => value));
    const unset = Object.fromEntries(
      Object.entries(fields)
        .filter(([, value]) => !value)
        .map(([field]) => [field, '']),
    );
    const result = await Activity.updateOne(filter, {
      $set: { ...set, title },
      ...(Object.keys(unset).length ? { $unset: unset } : {}),
    });
    found = result.matchedCount > 0;
  }
  if (found) emitToAll(SOCKET_EVENTS.activitiesChanged);
  return found;
}

/**
 * The same, for entries the system adds on the side of another action (a stage change, "lead
 * updated"). A problem with the timeline entry is logged and never undoes that action.
 */
export async function recordSystemActivity(entry) {
  try {
    return await recordActivity({ type: 'SYSTEM', direction: 'internal', ...entry });
  } catch (error) {
    logger.error({ err: error, subtype: entry.subtype }, 'Timeline entry could not be written');
    return null;
  }
}
