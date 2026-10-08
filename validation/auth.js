import { z } from 'zod';
import { THEMES } from '../models/user.model.js';

// What a signed-in user may change about themselves. Role, email and status are NOT here:
// those are changed only by an administrator through the users endpoints.
export const updateMyPreferencesBody = z
  .object({
    theme: z.enum(THEMES).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });
