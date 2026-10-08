import { z } from 'zod';
import { USER_STATUSES } from '../models/user.model.js';
import { email, newPassword, objectId, pagination, phone } from './common.js';

const name = z.string().trim().min(1, 'Enter a name').max(120);

export const listUsersQuery = z.object({
  ...pagination,
  search: z.string().trim().max(100).optional(),
  status: z.enum(USER_STATUSES).optional(),
  roleId: objectId.optional(),
});

export const createUserBody = z.object({
  name,
  email,
  password: newPassword,
  // The account type.
  roleId: objectId,
  // Who the new user reports to. A Sales Manager's new users always report to that manager,
  // whatever is sent here; the service enforces it.
  managerId: objectId.nullable().optional(),
  phone: phone.optional(),
});

export const updateUserBody = z
  .object({
    name: name.optional(),
    roleId: objectId.optional(),
    managerId: objectId.nullable().optional(),
    phone: phone.nullable().optional(),
    status: z.enum(['active', 'deactivated']).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });

export const resetPasswordBody = z.object({ password: newPassword });
