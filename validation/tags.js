import { z } from 'zod';
import { TAG_COLORS, TAG_TARGETS } from '../models/tag.model.js';
import { objectId } from './common.js';

const name = z.string().trim().min(1, 'Enter a name').max(40, 'Use at most 40 characters');
const color = z.enum(TAG_COLORS).nullable();
const appliesTo = z
  .array(z.enum(TAG_TARGETS))
  .min(1, 'Choose at least one')
  .transform((items) => [...new Set(items)]);

export const createTagBody = z.object({
  name,
  color: color.optional(),
  appliesTo: appliesTo.optional(),
});

export const updateTagBody = z
  .object({ name: name.optional(), color: color.optional(), appliesTo: appliesTo.optional() })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });

export const mergeTagBody = z.object({ intoTagId: objectId });

export const listTagsQuery = z.object({
  // "true" on the Settings screen: also count how many records carry each tag.
  withUses: z.enum(['true', 'false']).optional(),
});

// The tag ids of a record: at most 20, each once.
export const tagIds = z
  .array(objectId)
  .max(20, 'At most 20 tags')
  .transform((ids) => [...new Set(ids)]);
