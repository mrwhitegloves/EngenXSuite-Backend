import {
  countMyTasks,
  createTask,
  deleteTask,
  getTask,
  getTaskFormOptions,
  listTasks,
  updateTask,
} from '../services/tasks.service.js';
import { addNote, deleteNote, listTimeline, updateNote } from '../services/timeline.service.js';
import { sendCreated, sendList, sendOk } from '../lib/respond.js';

// The timeline, notes and tasks.
// Each function: read the validated request, call one service function, respond.

const context = (req) => ({ requestId: req.id });

// GET /api/timeline?accountId=… | opportunityId=… | contactId=…
export async function getTimeline(req, res) {
  const { items, pagination } = await listTimeline(req.user, req.validated.query);
  sendList(res, items, pagination);
}

// POST /api/notes
export async function postNote(req, res) {
  sendCreated(res, await addNote(req.user, req.validated.body, context(req)));
}

// PATCH /api/notes/:id
export async function patchNote(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await updateNote(req.user, params.id, body, context(req)));
}

// DELETE /api/notes/:id
export async function removeNote(req, res) {
  await deleteNote(req.user, req.validated.params.id, context(req));
  sendOk(res, { deleted: true });
}

// GET /api/tasks
export async function getTasks(req, res) {
  const { items, pagination } = await listTasks(req.user, req.validated.query);
  sendList(res, items, pagination);
}

// GET /api/tasks/summary: how many open tasks the signed-in person has in each view.
export async function getTaskSummary(req, res) {
  sendOk(res, await countMyTasks(req.user));
}

// GET /api/tasks/form-options
export async function getTaskOptions(req, res) {
  sendOk(res, await getTaskFormOptions(req.user));
}

// POST /api/tasks
export async function postTask(req, res) {
  sendCreated(res, await createTask(req.user, req.validated.body, context(req)));
}

// GET /api/tasks/:id
export async function getTaskById(req, res) {
  sendOk(res, await getTask(req.user, req.validated.params.id));
}

// PATCH /api/tasks/:id
export async function patchTask(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await updateTask(req.user, params.id, body, context(req)));
}

// DELETE /api/tasks/:id
export async function removeTask(req, res) {
  await deleteTask(req.user, req.validated.params.id, context(req));
  sendOk(res, { deleted: true });
}
