import { z } from 'zod';
import { USER_STATUSES } from '../models/user.model.js';
import { email, imageUrl, newPassword, objectId, pagination, phone } from './common.js';

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
  // Who the new user reports to. A Sales Manager's new users report to that manager unless
  // another manager is chosen; the service decides what is allowed.
  managerId: objectId.nullable().optional(),
  phone: phone.optional(),
  avatarUrl: imageUrl.optional(),
});

// Everything the CEO or the user's manager may change about a user (decision 0011).
export const updateUserBody = z
  .object({
    name: name.optional(),
    email: email.optional(),
    password: newPassword.optional(),
    roleId: objectId.optional(),
    managerId: objectId.nullable().optional(),
    phone: phone.nullable().optional(),
    avatarUrl: imageUrl.nullable().optional(),
    status: z.enum(['active', 'deactivated']).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });
