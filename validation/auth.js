import { z } from 'zod';
import { THEMES } from '../models/user.model.js';
import { email, newPassword } from './common.js';

// Sign-in: only shape is checked here. Password rules are NOT applied, so the response never
// hints whether a password "could" be valid; the answer is always just right or wrong.
export const loginBody = z.object({
  email,
  password: z.string().min(1, 'Enter your password').max(200),
});

export const changeMyPasswordBody = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password').max(200),
    newPassword,
  })
  .refine((body) => body.currentPassword !== body.newPassword, {
    message: 'Choose a password that is different from the current one',
    path: ['newPassword'],
  });

// What a signed-in user may change about themselves. Role, email and status are NOT here:
// those are changed only through the users endpoints.
export const updateMyPreferencesBody = z
  .object({
    theme: z.enum(THEMES).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });
