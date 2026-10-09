import { z } from 'zod';

// A screen key such as "users" or "audit-log".
const screen = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]{1,39}$/, 'Not a valid screen');

// The address values of a list: a small, flat set of short texts. Nothing else is stored.
const query = z
  .record(
    z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/, 'Not a valid filter name'),
    z.string().max(200),
  )
  .refine((value) => Object.keys(value).length <= 30, 'Too many filters');

export const listSavedViewsQuery = z.object({ screen });

export const createSavedViewBody = z.object({
  screen,
  name: z.string().trim().min(1, 'Enter a name').max(60),
  query,
});
