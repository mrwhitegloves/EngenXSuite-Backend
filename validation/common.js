import { z } from 'zod';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../infra/password.js';
import { DATE_PRESETS } from '../lib/dateRange.js';

// Building blocks reused by the validation schemas of every feature.

export const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Not a valid id');

export const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('Enter a valid email address').max(254));

// A password someone is choosing. (Sign-in uses a looser check: see validation/auth.js.)
export const newPassword = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(MAX_PASSWORD_LENGTH, 'Password is too long');

// Indian and international numbers, stored in E.164 form (+919876543210).
export const phone = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, 'Use the international format, for example +919876543210');

export const idParams = z.object({ id: objectId });

// Every endpoint with a date filter accepts these (Section 74). The values are worked out by
// resolveDateRange() in lib/dateRange.js, which also reports a wrong or impossible range.
export const dateRange = {
  range: z.enum(DATE_PRESETS).optional(),
  from: z.string().trim().max(10).optional(),
  to: z.string().trim().max(10).optional(),
};

/**
 * The `sort` value of a list: one of the given names, with a leading "-" for descending.
 *   sort: sortBy(['name', 'createdAt'])     accepts "name", "-name", "createdAt", "-createdAt"
 */
export function sortBy(names) {
  return z
    .string()
    .trim()
    .max(60)
    .refine((value) => names.includes(value.replace(/^-/, '')), 'Cannot sort by this')
    .optional();
}

// Every list endpoint accepts these (Master Prompt Section 74).
export const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};
