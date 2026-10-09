import { z } from 'zod';
import {
  ACCOUNT_POTENTIALS,
  ACCOUNT_STATUSES,
  COMPANY_SIZES,
  RELATIONSHIP_HEALTH,
} from '../models/account.model.js';
import { dateRange, objectId, pagination, sortBy } from './common.js';

// Short free text. An empty text clears the field (null).
const text = (max = 200) =>
  z
    .string()
    .trim()
    .max(max, `Use at most ${max} characters`)
    .transform((value) => (value === '' ? null : value))
    .nullable();

const paise = z.number().int('Use a whole number of paise').min(0).max(1e15).nullable();

const address = z
  .object({
    addressLine: text(300),
    city: text(100),
    state: text(100),
    country: text(100),
    pincode: text(12),
  })
  .partial();

const stringList = z.array(z.string().trim().min(1).max(100)).max(30);

// 15 characters: state code, PAN, entity number, "Z", check character.
const gstin = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Not a valid GSTIN');
const pan = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Not a valid PAN');
const emptyToNull = z.literal('').transform(() => null);

const website = z
  .string()
  .trim()
  .max(300)
  .transform((value) => (value && !/^https?:\/\//i.test(value) ? `https://${value}` : value))
  .refine((value) => value === '' || z.url().safeParse(value).success, 'Enter a web address')
  .transform((value) => (value === '' ? null : value))
  .nullable();

const industrial = z
  .object({
    manufacturingProcess: text(),
    plantType: text(),
    approxPlantSize: text(),
    automationLevel: text(),
    digitalMaturity: text(),
    existingPlc: text(),
    existingScada: text(),
    existingMes: text(),
    existingErp: text(),
    existingIot: text(),
    existingVendors: stringList,
    systemIntegrators: stringList,
  })
  .partial();

const commercial = z
  .object({
    accountPotential: z.enum(ACCOUNT_POTENTIALS).nullable(),
    estimatedOpportunityValuePaise: paise,
    existingBusinessPaise: paise,
    strategicImportance: z.number().int().min(1).max(5).nullable(),
    relationshipHealth: z.enum(RELATIONSHIP_HEALTH).nullable(),
  })
  .partial();

// Every field a person can set on an account.
const fields = {
  name: z.string().trim().min(1, 'Enter the company name').max(200),
  industry: text(100),
  companyType: text(100),
  website,
  hq: address,
  region: text(100),
  companySize: z.enum(COMPANY_SIZES).nullable(),
  annualRevenuePaise: paise,
  gstin: z.union([emptyToNull, gstin]).nullable(),
  pan: z.union([emptyToNull, pan]).nullable(),
  billingAddress: address,
  status: z.enum(ACCOUNT_STATUSES),
  industrial,
  commercial,
  // Changing these two needs the "assign" permission; the service checks it.
  ownerId: objectId,
  assignedUserIds: z
    .array(objectId)
    .max(20, 'At most 20 people')
    .transform((ids) => [...new Set(ids)]),
};

export const createAccountBody = z.object({
  ...Object.fromEntries(Object.entries(fields).map(([key, schema]) => [key, schema.optional()])),
  name: fields.name,
  // Sent as true after the person was told "a company with this name exists" and chose to go on.
  confirmDuplicate: z.boolean().optional(),
});

export const updateAccountBody = z
  .object({
    ...Object.fromEntries(Object.entries(fields).map(([key, schema]) => [key, schema.optional()])),
    confirmDuplicate: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).some((key) => key !== 'confirmDuplicate'), {
    message: 'Nothing to update',
  });

// The columns the Accounts list can be sorted by.
export const ACCOUNT_SORTS = ['name', 'status', 'createdAt', 'lastActivityAt'];

export const listAccountsQuery = z.object({
  ...pagination,
  ...dateRange,
  sort: sortBy(ACCOUNT_SORTS),
  search: z.string().trim().max(100).optional(),
  status: z.enum(ACCOUNT_STATUSES).optional(),
  industry: z.string().trim().max(100).optional(),
  region: z.string().trim().max(100).optional(),
  ownerId: objectId.optional(),
});
