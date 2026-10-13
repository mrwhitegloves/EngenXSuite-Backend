import { sendCreated, sendOk } from '../lib/respond.js';
import {
  deleteDocument,
  listAccountDocuments,
  uploadDocument,
} from '../services/documents.service.js';

// The documents of a company. Each function: read the validated request, call one service
// function, respond.

// GET /api/documents?accountId=…
export async function getDocuments(req, res) {
  sendOk(res, await listAccountDocuments(req.user, req.validated.query.accountId));
}

// POST /api/documents: a file, with the company it is for.
export async function postDocument(req, res) {
  sendCreated(
    res,
    await uploadDocument(req.user, req.validated.body, req.file, { requestId: req.id }),
  );
}

// DELETE /api/documents/:id
export async function removeDocument(req, res) {
  sendOk(res, await deleteDocument(req.user, req.validated.params.id, { requestId: req.id }));
}
