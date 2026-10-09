import { z } from 'zod';
import { dateRange, objectId, pagination } from './common.js';

// Names such as "users" or "user.password_changed_by_admin".
const name = z
  .string()
  .trim()
  .max(80)
  .regex(/^[\w.-]+$/, 'Not a valid value');

export const listAuditLogsQuery = z.object({
  ...pagination,
  ...dateRange,
  // Who did it. "system" means entries written by the system itself (no user).
  userId: z.union([objectId, z.literal('system')]).optional(),
  entityType: name.optional(),
  action: name.optional(),
});
