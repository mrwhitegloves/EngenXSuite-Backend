import { fileURLToPath } from 'node:url';
import { sendCreated, sendList, sendOk } from '../lib/respond.js';
import { forbidden } from '../lib/errors.js';
import {
  createGenerated,
  deleteGenerated,
  getGenerated,
  listGenerated,
  mayUseGenerator,
  updateGenerated,
} from '../services/generatedDocuments.service.js';

// Document generator (/api/generator/<kind>). Each function: read the validated request, call
// one service, respond. The kind ("proposal", "letterhead", "invoice") is fixed by the route.

const SEAL_FILE = fileURLToPath(new URL('../assets/generator/seal-signature.png', import.meta.url));

export const generatedController = (kind) => ({
  // GET /api/generator/<kind>s
  async list(req, res) {
    const { items, pagination } = await listGenerated(req.user, kind, req.validated.query);
    sendList(res, items, pagination);
  },
  // GET /api/generator/<kind>s/:id
  async get(req, res) {
    sendOk(res, await getGenerated(req.user, kind, req.validated.params.id));
  },
  // POST /api/generator/<kind>s
  async create(req, res) {
    sendCreated(
      res,
      await createGenerated(req.user, kind, req.validated.body, { requestId: req.id }),
    );
  },
  // PATCH /api/generator/<kind>s/:id
  async update(req, res) {
    const { params, body } = req.validated;
    sendOk(res, await updateGenerated(req.user, kind, params.id, body, { requestId: req.id }));
  },
  // DELETE /api/generator/<kind>s/:id
  async remove(req, res) {
    sendOk(
      res,
      await deleteGenerated(req.user, kind, req.validated.params.id, { requestId: req.id }),
    );
  },
});

// GET /api/generator/assets/seal: the company seal with the signature, for the documents.
// Only for people who may use the generator; never cached by a shared cache.
export function getSeal(req, res, next) {
  if (!mayUseGenerator(req.user)) return next(forbidden());
  res.set('Cache-Control', 'private, max-age=3600');
  return res.sendFile(SEAL_FILE);
}
