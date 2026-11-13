import express, { Router } from 'express';
import {
  generatedController,
  getSeal,
  postPdf,
} from '../controllers/generatedDocuments.controller.js';
import { GENERATED_KINDS, MAX_PDF_HTML_BYTES } from '../constants/generatedDocuments.js';
import { createExportLimiter } from '../middleware/rateLimit.js';
import { authorize } from '../middleware/authorize.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import { idParams } from '../validation/common.js';
import {
  createGeneratedBody,
  generatorPdfBody,
  listGeneratedQuery,
  updateGeneratedBody,
} from '../validation/generatedDocuments.js';

// /api/generator: the Document generator (founder, 2026-11-12).
//   /proposals   feature "proposals"
//   /letterheads feature "documents"
//   /invoices    feature "invoices"
//   /assets/seal the company seal with the signature (signed-in users of the generator only)
//   /pdf         one-click PDF of a finished page (own body limit; 60 per hour per person)

function kindRouter(kind) {
  const feature = GENERATED_KINDS[kind].feature;
  const controller = generatedController(kind);
  const router = Router();
  router.get(
    '/',
    authorize(feature, 'view'),
    validate({ query: listGeneratedQuery }),
    controller.list,
  );
  router.post(
    '/',
    authorize(feature, 'create'),
    validate({ body: createGeneratedBody }),
    controller.create,
  );
  router.get('/:id', authorize(feature, 'view'), validate({ params: idParams }), controller.get);
  router.patch(
    '/:id',
    authorize(feature, 'edit'),
    validate({ params: idParams, body: updateGeneratedBody }),
    controller.update,
  );
  router.delete(
    '/:id',
    authorize(feature, 'delete'),
    validate({ params: idParams }),
    controller.remove,
  );
  return router;
}

const router = Router();
router.use(requireAuth);
router.get('/assets/seal', getSeal);
router.post(
  '/pdf',
  createExportLimiter({ limit: 60 }),
  express.json({ limit: MAX_PDF_HTML_BYTES + 64 * 1024 }),
  validate({ body: generatorPdfBody }),
  postPdf,
);
for (const kind of Object.keys(GENERATED_KINDS)) router.use(`/${kind}s`, kindRouter(kind));

export default router;
