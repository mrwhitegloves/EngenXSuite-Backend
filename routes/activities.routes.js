import { Router } from 'express';
import {
  getTaskById,
  getTaskOptions,
  getTaskSummary,
  getTasks,
  getTimeline,
  patchNote,
  patchTask,
  postNote,
  postTask,
  removeNote,
  removeTask,
} from '../controllers/activities.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import {
  createNoteBody,
  createTaskBody,
  listTasksQuery,
  listTimelineQuery,
  updateNoteBody,
  updateTaskBody,
} from '../validation/activities.js';
import { idParams } from '../validation/common.js';

// The timeline and notes belong to a company, a lead or a contact: there is no permission of
// their own. The service loads that record with the usual access check (404 outside the
// person's scope), and only then reads or writes.
export const timelineRouter = Router();
timelineRouter.use(requireAuth);
timelineRouter.get('/', validate({ query: listTimelineQuery }), getTimeline);

export const notesRouter = Router();
notesRouter.use(requireAuth);
notesRouter.post('/', validate({ body: createNoteBody }), postNote);
notesRouter.patch('/:id', validate({ params: idParams, body: updateNoteBody }), patchNote);
notesRouter.delete('/:id', validate({ params: idParams }), removeNote);

// Tasks. authorize() answers "may this person do this at all"; which tasks exactly is decided
// in the service.
export const tasksRouter = Router();
const FEATURE = 'tasks';
tasksRouter.use(requireAuth);
tasksRouter.get('/', authorize(FEATURE, 'view'), validate({ query: listTasksQuery }), getTasks);
tasksRouter.get('/summary', authorize(FEATURE, 'view'), getTaskSummary);
tasksRouter.get('/form-options', authorize(FEATURE, 'view'), getTaskOptions);
tasksRouter.post('/', authorize(FEATURE, 'create'), validate({ body: createTaskBody }), postTask);
tasksRouter.get('/:id', authorize(FEATURE, 'view'), validate({ params: idParams }), getTaskById);
tasksRouter.patch(
  '/:id',
  authorize(FEATURE, 'edit'),
  validate({ params: idParams, body: updateTaskBody }),
  patchTask,
);
tasksRouter.delete(
  '/:id',
  authorize(FEATURE, 'delete'),
  validate({ params: idParams }),
  removeTask,
);
