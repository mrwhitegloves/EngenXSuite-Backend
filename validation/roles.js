import { z } from 'zod';
import { ACTIONS, FEATURES, SCOPES } from '../constants/permissions.js';

const grant = z.object({
  feature: z.enum(FEATURES),
  action: z.enum(ACTIONS),
  scope: z.enum(SCOPES),
});

// The full list of what an account type may do. One entry per feature + action at most;
// leaving a feature + action out means "not allowed".
const grants = z
  .array(grant)
  .max(FEATURES.length * ACTIONS.length)
  .refine(
    (list) => new Set(list.map((item) => `${item.feature}:${item.action}`)).size === list.length,
    { message: 'The same permission appears twice' },
  );

const name = z.string().trim().min(2, 'Enter a name').max(60);
const description = z.string().trim().max(300);

export const createRoleBody = z.object({
  name,
  description: description.optional(),
  grants: grants.default([]),
});

export const updateRoleBody = z
  .object({
    name: name.optional(),
    description: description.optional(),
    grants: grants.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });
