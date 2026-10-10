import { z } from 'zod';
import { ACTIVITY_TYPES } from '../models/activity.model.js';
import { TASK_PRIORITIES, TASK_STATUSES, TASK_TYPES } from '../models/task.model.js';
import { objectId, pagination } from './common.js';

// The timeline, notes and tasks.

// What an entry or a task is about. The service checks that the person may see that record.
const target = {
  accountId: objectId.optional(),
  opportunityId: objectId.optional(),
  contactId: objectId.optional(),
};

export const listTimelineQuery = z.object({
  ...pagination,
  ...target,
  type: z.enum(ACTIVITY_TYPES).optional(),
});

const noteContent = z
  .string()
  .trim()
  .min(1, 'Write the note first')
  .max(5000, 'Use at most 5000 characters');

export const createNoteBody = z.object({ ...target, content: noteContent });
export const updateNoteBody = z.object({ content: noteContent });

// A moment, as the browser sends it.
const moment = z
  .string()
  .max(40)
  .transform((value) => new Date(value))
  .refine((value) => !Number.isNaN(value.getTime()), 'Not a valid date and time');

const taskFields = {
  title: z.string().trim().min(1, 'Say what has to be done').max(200),
  description: z
    .string()
    .trim()
    .max(2000)
    .transform((value) => (value === '' ? null : value))
    .nullable(),
  type: z.enum(TASK_TYPES),
  priority: z.enum(TASK_PRIORITIES),
  dueAt: moment.nullable(),
  remindAt: moment.nullable(),
  // Giving a task to someone else needs the "assign" permission; the service checks it.
  assigneeId: objectId,
};
const optionalTaskFields = Object.fromEntries(
  Object.entries(taskFields).map(([key, schema]) => [key, schema.optional()]),
);

export const createTaskBody = z.object({
  ...optionalTaskFields,
  title: taskFields.title,
  ...target,
});

export const updateTaskBody = z
  .object({ ...optionalTaskFields, status: z.enum(TASK_STATUSES).optional() })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });

export const TASK_VIEWS = ['today', 'upcoming', 'overdue', 'completed', 'open', 'all'];

export const listTasksQuery = z.object({
  ...pagination,
  view: z.enum(TASK_VIEWS).default('open'),
  assigneeId: objectId.optional(),
  // The tasks of one lead or one company.
  opportunityId: objectId.optional(),
  accountId: objectId.optional(),
  search: z.string().trim().max(100).optional(),
});
