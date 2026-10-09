import {
  createStatus,
  deleteStatus,
  listStatuses,
  reorderStatuses,
  updateStatus,
} from '../services/statusLists.service.js';
import { sendCreated, sendOk } from '../lib/respond.js';

// GET /api/status-lists/:list: every status of one list (account-statuses or lead-statuses).
export async function getStatuses(req, res) {
  sendOk(res, await listStatuses(req.validated.params.list));
}

// POST /api/status-lists/:list: add a status.
export async function postStatus(req, res) {
  const { params, body } = req.validated;
  sendCreated(res, await createStatus(req.user, params.list, body, { requestId: req.id }));
}

// PUT /api/status-lists/:list/order: put the statuses in a new order.
export async function putStatusOrder(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await reorderStatuses(req.user, params.list, body.ids, { requestId: req.id }));
}

// PATCH /api/status-lists/:list/:id: rename, recolour, switch on or off, make the default.
export async function patchStatus(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await updateStatus(req.user, params.list, params.id, body, { requestId: req.id }));
}

// DELETE /api/status-lists/:list/:id: delete a status that nothing uses.
export async function removeStatus(req, res) {
  const { params } = req.validated;
  await deleteStatus(req.user, params.list, params.id, { requestId: req.id });
  sendOk(res, { deleted: true });
}
