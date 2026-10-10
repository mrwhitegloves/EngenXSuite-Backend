import { z } from 'zod';
import { NOTIFICATION_TYPE_KEYS } from '../models/notification.model.js';
import { dateRange, pagination } from './common.js';

export const listNotificationsQuery = z.object({
  ...pagination,
  ...dateRange,
  unread: z.enum(['true', 'false']).optional(),
  type: z.enum(NOTIFICATION_TYPE_KEYS).optional(),
  search: z.string().trim().max(100).optional(),
});

export const notificationPreferencesBody = z
  .object({
    // The master switch.
    enabled: z.boolean().optional(),
    // One switch per kind of notification: { task_assigned: false, … }
    types: z.record(z.string().max(60), z.boolean()).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });
