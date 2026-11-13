import { fileURLToPath } from 'node:url';
import { sendCreated, sendList, sendOk } from '../lib/respond.js';
import { createAppError, forbidden } from '../lib/errors.js';
import { isPdfRendererAvailable, renderPdf } from '../infra/pdfRenderer.js';
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

/** "Proposal – Tata Steel" → a file name safe in a download header. */
const safeFileName = (name) =>
  `${
    name
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'document'
  }.pdf`;

// POST /api/generator/pdf: the finished page as a PDF file (one click, no print dialog).
// Only for people who may use the generator. Without a browser on the machine: 503, and the
// screen uses the browser's own print dialog instead.
export async function postPdf(req, res, next) {
  if (!mayUseGenerator(req.user)) return next(forbidden());
  if (!isPdfRendererAvailable()) {
    return next(
      createAppError('PDF_UNAVAILABLE', 503, 'PDF downloads are not set up on the server.'),
    );
  }
  const { html, fileName } = req.validated.body;
  const pdf = await renderPdf(html);
  const name = safeFileName(fileName);
  const ascii = name.replace(/[^\x20-\x7e]/g, '_');
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Length': String(pdf.length),
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'private, no-store',
  });
  return res.send(pdf);
}
