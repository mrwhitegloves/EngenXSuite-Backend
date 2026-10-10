import { z } from 'zod';
import { STAGE_TYPES } from '../models/pipelineStage.model.js';
import { STATUS_LIST_KEYS } from '../services/statusLists.service.js';
import { objectId } from './common.js';

const list = z.enum(STATUS_LIST_KEYS);
const name = z.string().trim().min(1, 'Enter a name').max(60);
// A design-token name such as "success" or "warning"; never a colour value.
const color = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]{0,29}$/, 'Not a valid colour name')
  .nullable();

export const statusListParams = z.object({ list });
export const statusParams = z.object({ list, id: objectId });

// For pipeline stages only (the service refuses them on the other lists).
const type = z.enum(STAGE_TYPES);
const defaultProbability = z.number().int().min(0).max(100).nullable();

export const createStatusBody = z.object({
  name,
  color: color.optional(),
  type: type.optional(),
  defaultProbability: defaultProbability.optional(),
});

export const updateStatusBody = z
  .object({
    name: name.optional(),
    color: color.optional(),
    isActive: z.boolean().optional(),
    // Only "make this the default" exists; another status becomes the default the same way.
    isDefault: z.literal(true).optional(),
    type: type.optional(),
    defaultProbability: defaultProbability.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });

export const reorderStatusesBody = z.object({
  ids: z.array(objectId).min(1).max(200),
});
