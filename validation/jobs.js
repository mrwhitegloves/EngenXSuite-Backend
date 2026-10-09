import { z } from 'zod';
import { QUEUE_NAMES } from '../config/queues.js';
import { pagination } from './common.js';

const queue = z.enum(QUEUE_NAMES);

export const failedJobsQuery = z.object({ queue, ...pagination });

export const jobParams = z.object({
  queue,
  // Job ids come from the queue library: numbers, or a text id chosen when the job was added.
  jobId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[\w.:-]+$/, 'Not a valid job id'),
});

export const testJobBody = z.object({ shouldFail: z.boolean().default(false) });
