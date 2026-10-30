import { sendCreated, sendList, sendOk } from '../lib/respond.js';
import {
  createLink,
  deleteLink,
  listLinks,
  removeThumbnail,
  saveThumbnail,
  updateLink,
} from '../services/links.service.js';

// Links (/api/links). Each function: read the validated request, call one service, respond.

// GET /api/links
export async function getLinks(req, res) {
  const { items, pagination } = await listLinks(req.validated.query);
  sendList(res, items, pagination);
}

// POST /api/links
export async function postLink(req, res) {
  sendCreated(res, await createLink(req.user, req.validated.body, { requestId: req.id }));
}

// PATCH /api/links/:id
export async function patchLink(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await updateLink(req.user, params.id, body, { requestId: req.id }));
}

// DELETE /api/links/:id
export async function removeLink(req, res) {
  sendOk(res, await deleteLink(req.user, req.validated.params.id, { requestId: req.id }));
}

// POST /api/links/:id/thumbnail (multipart field "file")
export async function postThumbnail(req, res) {
  const id = req.validated.params.id;
  sendOk(res, await saveThumbnail(req.user, id, req.file, { requestId: req.id }));
}

// DELETE /api/links/:id/thumbnail
export async function deleteThumbnail(req, res) {
  sendOk(res, await removeThumbnail(req.user, req.validated.params.id, { requestId: req.id }));
}
