import { sendCreated, sendOk } from '../lib/respond.js';
import {
  browseDocuments,
  createFolder,
  deleteDocument,
  deleteFolder,
  listAllFolders,
  renameFolder,
  updateDocument,
  uploadDocument,
} from '../services/documents.service.js';

// The documents library. Each function: read the validated request, call one service function,
// respond.

// GET /api/documents?folderId=…&search=…: what one folder holds, or a search.
export async function getDocuments(req, res) {
  sendOk(res, await browseDocuments(req.user, req.validated.query));
}

// GET /api/documents/folders: every folder with its path.
export async function getFolders(req, res) {
  sendOk(res, await listAllFolders());
}

// POST /api/documents: a file, with the folder it goes into.
export async function postDocument(req, res) {
  sendCreated(
    res,
    await uploadDocument(req.user, req.validated.body, req.file, { requestId: req.id }),
  );
}

// PATCH /api/documents/:id: rename or move.
export async function patchDocument(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await updateDocument(req.user, params.id, body, { requestId: req.id }));
}

// DELETE /api/documents/:id
export async function removeDocument(req, res) {
  sendOk(res, await deleteDocument(req.user, req.validated.params.id, { requestId: req.id }));
}

// POST /api/documents/folders
export async function postFolder(req, res) {
  sendCreated(res, await createFolder(req.user, req.validated.body, { requestId: req.id }));
}

// PATCH /api/documents/folders/:id
export async function patchFolder(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await renameFolder(req.user, params.id, body, { requestId: req.id }));
}

// DELETE /api/documents/folders/:id
export async function removeFolder(req, res) {
  sendOk(res, await deleteFolder(req.user, req.validated.params.id, { requestId: req.id }));
}
