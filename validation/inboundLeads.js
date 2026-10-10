import { z } from 'zod';
import { INBOUND_STATUSES, LEAD_FORM_FIELDS } from '../models/inboundLead.model.js';
import { ASSIGNMENT_MODES } from '../models/settings.model.js';
import { objectId, pagination } from './common.js';

// Lead forms, the inbound leads list, and the lead assignment rule.

const userIds = z
  .array(objectId)
  .max(100)
  .transform((ids) => [...new Set(ids)]);

export const updateLeadAssignmentBody = z
  .object({
    mode: z.enum(ASSIGNMENT_MODES),
    // The people of "round robin: chosen people" and "fewest open leads".
    userIds,
    // The person of "always the same person".
    fixedUserId: objectId.nullable(),
    // People who get no new lead for now.
    awayUserIds: userIds,
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });

export const updateLeadFormBody = z
  .object({
    fieldMapping: z
      .array(
        z.object({
          question: z.string().min(1).max(200),
          crmField: z.enum(Object.keys(LEAD_FORM_FIELDS)),
        }),
      )
      .max(100),
    defaultOwnerId: objectId.nullable(),
    defaultSolutionCategoryId: objectId.nullable(),
    isActive: z.boolean(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });

export const listInboundLeadsQuery = z.object({
  ...pagination,
  status: z.enum(INBOUND_STATUSES).optional(),
});

// Meta's one-time check when the webhook address is set up.
export const metaVerifyQuery = z.object({
  'hub.mode': z.string().max(40).optional(),
  'hub.verify_token': z.string().max(500).optional(),
  'hub.challenge': z.string().max(500).optional(),
});
