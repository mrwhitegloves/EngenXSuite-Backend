import { z } from 'zod';
import { USER_STATUSES } from '../models/user.model.js';
import { email, newPassword, objectId, pagination, phone, sortBy } from './common.js';

const name = z.string().trim().min(1, 'Enter a name').max(120);

// The columns the Users list can be sorted by.
export const USER_SORTS = ['name', 'status', 'lastLoginAt', 'createdAt'];

export const listUsersQuery = z.object({
  ...pagination,
  sort: sortBy(USER_SORTS),
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
    status: z.enum(['active', 'deactivated']).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });
