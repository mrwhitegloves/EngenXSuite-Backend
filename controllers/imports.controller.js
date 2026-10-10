import {
  deleteTemplate,
  getImport,
  getImportOptions,
  listImports,
  previewImport,
  saveTemplate,
  startImport,
  undoImport,
  uploadImport,
} from '../services/imports.service.js';
import { sendCreated, sendList, sendOk } from '../lib/respond.js';

// CSV import. Each function: read the validated request, call one service function, respond.

const context = (req) => ({ requestId: req.id });

// GET /api/imports
export async function getImports(req, res) {
  const { items, pagination } = await listImports(req.user, req.validated.query);
  sendList(res, items, pagination);
}

// GET /api/imports/options: fields, limits and saved mappings.
export async function getOptions(req, res) {
  sendOk(res, await getImportOptions());
}

// POST /api/imports: upload a CSV file (multipart field "file").
export async function postImport(req, res) {
  sendCreated(res, await uploadImport(req.user, req.file, req.validated.body, context(req)));
}

// GET /api/imports/:id
export async function getImportById(req, res) {
  sendOk(res, await getImport(req.user, req.validated.params.id));
}

// POST /api/imports/:id/preview: check every row with the chosen columns; saves nothing.
export async function postPreview(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await previewImport(req.user, params.id, body));
}

// POST /api/imports/:id/run: start saving the rows in the background.
export async function postRun(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await startImport(req.user, params.id, body, context(req)));
}

// POST /api/imports/:id/undo: remove what this import created, in the background.
export async function postUndo(req, res) {
  sendOk(res, await undoImport(req.user, req.validated.params.id, context(req)));
}

// POST /api/imports/templates: save a column mapping under a name.
export async function postTemplate(req, res) {
  sendCreated(res, await saveTemplate(req.user, req.validated.body));
}

// DELETE /api/imports/templates/:id
export async function removeTemplate(req, res) {
  await deleteTemplate(req.validated.params.id);
  sendOk(res, { deleted: true });
}
