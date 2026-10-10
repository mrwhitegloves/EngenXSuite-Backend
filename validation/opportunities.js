import { z } from 'zod';
import {
  BUDGET_STATUSES,
  BUYING_ROLES,
  FEASIBILITY,
  LEAD_SOURCES,
  RISK_LEVELS,
  SCOPE_LEVELS,
  STAGE_CHANGE_VIA,
} from '../models/opportunity.model.js';
import { updateAccountBody } from './accounts.js';
import { dateRange, objectId, pagination, sortBy } from './common.js';
import { updateContactBody } from './contacts.js';
import { tagIds } from './tags.js';

// Free text. An empty text clears the field (null).
const text = (max = 200) =>
  z
    .string()
    .trim()
    .max(max, `Use at most ${max} characters`)
    .transform((value) => (value === '' ? null : value))
    .nullable();

const idList = (max, message) =>
  z
    .array(objectId)
    .max(max, message)
    .transform((ids) => [...new Set(ids)]);

// A day typed in a date field ("2026-12-31"): stored as the start of that day in India.
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date')
  .transform((value) => new Date(`${value}T00:00:00+05:30`))
  .refine((value) => !Number.isNaN(value.getTime()), 'Choose a date')
  .nullable();
// A moment, as the browser sends it.
const moment = z
  .string()
  .max(40)
  .transform((value) => new Date(value))
  .refine((value) => !Number.isNaN(value.getTime()), 'Not a valid date and time');

// Every field a person can set on a lead. (The lead code is given by the system; the stage is
// changed by the stage service.)
const fields = {
  name: z.string().trim().min(1, 'Enter a name for the lead').max(200),
  plantId: objectId.nullable(),
  primaryContactId: objectId.nullable(),
  solutionCategoryIds: idList(16, 'At most 16 categories'),
  tagIds,
  // One of the lead statuses managed in Settings. Left out on create: the default is used.
  leadStatusId: objectId,
  problemStatement: text(2000),
  requirement: text(2000),
  expectedImpact: text(2000),
  scope: z
    .object({
      level: z.enum(SCOPE_LEVELS).nullable(),
      machineIds: idList(50, 'At most 50 machines'),
      unitIds: idList(50, 'At most 50 departments and lines'),
    })
    .partial(),
  estimatedValuePaise: z.number().int('Use a whole number of paise').min(0).max(1e15).nullable(),
  probability: z.number().int().min(0, 'From 0 to 100').max(100, 'From 0 to 100').nullable(),
  expectedCloseDate: day,
  competitor: text(),
  technicalFeasibility: z.enum(FEASIBILITY).nullable(),
  budgetStatus: z.enum(BUDGET_STATUSES).nullable(),
  decisionTimeline: text(),
  stakeholders: z
    .array(
      z.object({ contactId: objectId, buyingRole: z.enum(BUYING_ROLES).nullable().optional() }),
    )
    .max(20, 'At most 20 people'),
  nextAction: z.object({ text: text(300), dueAt: moment.nullable() }).partial(),
  risk: z.object({ level: z.enum(RISK_LEVELS).nullable(), note: text(500) }).partial(),
  // Changing these two needs the "assign" permission; the service checks it.
  // No owner (null) means "unassigned".
  ownerId: objectId.nullable(),
  assignedUserIds: idList(20, 'At most 20 people'),
};
const optionalFields = Object.fromEntries(
  Object.entries(fields).map(([key, schema]) => [key, schema.optional()]),
);

const closing = {
  // Why it was won or lost; needed when the new stage is a won or lost stage.
  closeReason: text(500).optional(),
  lostToCompetitor: text().optional(),
  // Where the change was made, for the stage history.
  via: z.enum(STAGE_CHANGE_VIA).optional(),
};

export const createLeadBody = z.object({
  ...optionalFields,
  name: fields.name,
  accountId: objectId,
  // Left out: the first open stage of the pipeline.
  stageId: objectId.optional(),
  source: z.enum(LEAD_SOURCES).optional(),
});

export const updateLeadBody = z
  .object({
    ...optionalFields,
    stageId: objectId.optional(),
    ...closing,
    // Changes to the lead's main contact and to its company, made in the same form. They are
    // saved through the contact and account services, with those records' own permissions.
    contact: updateContactBody.optional(),
    account: updateAccountBody.optional(),
    // The lead's `updatedAt` as the form received it. When someone else saved in between, the
    // save is refused (409) unless `overwrite` is sent after the person saw the newer values.
    expectedUpdatedAt: moment.optional(),
    overwrite: z.boolean().optional(),
  })
  .refine(
    (body) =>
      Object.keys(body).some((key) => !['expectedUpdatedAt', 'overwrite', 'via'].includes(key)),
    { message: 'Nothing to update' },
  );

export const changeStageBody = z.object({ stageId: objectId, ...closing });

export const LEAD_SORTS = [
  'name',
  'leadCode',
  'createdAt',
  'estimatedValuePaise',
  'expectedCloseDate',
  'stageEnteredAt',
  'lastActivityAt',
];

const leadFilters = {
  ...dateRange,
  sort: sortBy(LEAD_SORTS),
  search: z.string().trim().max(100).optional(),
  status: z.enum(['open', 'won', 'lost']).optional(),
  stageId: objectId.optional(),
  leadStatusId: objectId.optional(),
  accountId: objectId.optional(),
  // A user's id, or "unassigned" for leads nobody owns yet.
  ownerId: z.union([objectId, z.literal('unassigned')]).optional(),
  solutionCategoryId: objectId.optional(),
  tagId: objectId.optional(),
  // Estimated value, in paise.
  minValue: z.coerce.number().int().min(0).optional(),
  maxValue: z.coerce.number().int().min(0).optional(),
};

export const listLeadsQuery = z.object({ ...pagination, ...leadFilters });
// The export takes the list's filters and sort; it has no pages.
export const exportLeadsQuery = z.object(leadFilters);
// The board takes the same filters; it has no pages and its own order.
export const boardQuery = z.object(leadFilters).omit({ sort: true, stageId: true });
