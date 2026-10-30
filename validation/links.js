import { z } from 'zod';
import { pagination, sortBy } from './common.js';

// Input rules of /api/links.

const url = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => {
    try {
      return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, 'Enter a full web address that starts with https://');

const credential = z.strictObject({
  key: z.string().trim().min(1, 'Name the detail, e.g. Email ID').max(60),
  value: z.string().max(500),
});

const fields = {
  name: z.string().trim().min(1, 'Enter a name').max(120),
  url,
  description: z.string().trim().max(1000).default(''),
  credentials: z.array(credential).max(20, 'At most 20 details').default([]),
};

export const createLinkBody = z.strictObject(fields);

export const updateLinkBody = z
  .strictObject({
    name: fields.name.optional(),
    url: url.optional(),
    description: z.string().trim().max(1000).optional(),
    credentials: z.array(credential).max(20, 'At most 20 details').optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change');

export const listLinksQuery = z.object({
  search: z.string().trim().max(100).optional(),
  sort: sortBy(['name', 'createdAt', 'updatedAt']),
  ...pagination,
});
