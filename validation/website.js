import { z } from 'zod';
import { dateRange, pagination } from './common.js';

// The Website screen's analytics: every view takes the shared date filter.
export const websiteOverviewQuery = z.object({ ...dateRange });

export const websiteListQuery = z.object({
  ...pagination,
  ...dateRange,
  search: z.string().trim().max(100).optional(),
});
