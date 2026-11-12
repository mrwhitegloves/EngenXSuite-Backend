import { Router } from 'express';
import { generatedController, getSeal } from '../controllers/generatedDocuments.controller.js';
import { GENERATED_KINDS } from '../constants/generatedDocuments.js';
import { authorize } from '../middleware/authorize.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import { idParams } from '../validation/common.js';
import {
  createGeneratedBody,
  listGeneratedQuery,
  updateGeneratedBody,
} from '../validation/generatedDocuments.js';

// /api/generator: the Document generator (founder, 2026-11-12).
//   /proposals   feature "proposals"
//   /letterheads feature "documents"
//   /invoices    feature "invoices"
//   /assets/seal the company seal with the signature (signed-in users of the generator only)

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
for (const kind of Object.keys(GENERATED_KINDS)) router.use(`/${kind}s`, kindRouter(kind));

export default router;
