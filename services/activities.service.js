import { SOCKET_EVENTS } from '../constants/socketEvents.js';
import { logger } from '../infra/logger.js';
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
  return activity.toObject();
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
