import { z } from 'zod';
import { CALL_DIRECTIONS, CALL_OUTCOMES, CALL_STATUSES } from '../models/call.model.js';
import { dateRange, objectId, pagination, sortBy } from './common.js';

// The columns the call log can be sorted by.
export const CALL_SORTS = ['startedAt', 'durationSec', 'cost'];

export const startCallBody = z.object({
  // Who to call. The number is taken from the contact, never from the request.
  contactId: objectId,
  // The lead the call is about, when it is started from a lead.
  opportunityId: objectId.optional(),
});

export const listCallsQuery = z.object({
  ...pagination,
  // The calls of ONE record. With none of the three: every call I may see (by the "calls" scope).
  opportunityId: objectId.optional(),
  accountId: objectId.optional(),
  contactId: objectId.optional(),
  // Only for the list of every call: "no" = calls that belong to no person yet.
  linked: z.enum(['yes', 'no']).optional(),
  // The filters of the call log (the list of every call I may see).
  ...dateRange,
  sort: sortBy(CALL_SORTS),
  search: z.string().trim().max(100).optional(),
  direction: z.enum(CALL_DIRECTIONS).optional(),
  status: z.enum(CALL_STATUSES).optional(),
  outcome: z.enum(CALL_OUTCOMES).optional(),
  // Whose calls.
  userId: objectId.optional(),
  recording: z.enum(['yes']).optional(),
});

export const updateCallBody = z
  .object({
    outcome: z.enum(CALL_OUTCOMES).nullable(),
    // Put the call on another person (their company and open lead follow); null takes it off.
    contactId: objectId.nullable(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });

export const updateCallSettingsBody = z
  .object({
    recordingEnabled: z.boolean(),
    announcementEnabled: z.boolean(),
    consentText: z.string().trim().min(5, 'Write the announcement').max(300),
    defaultInboundUserId: objectId.nullable(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });
