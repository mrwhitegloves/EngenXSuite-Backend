import { Router } from 'express';
import {
  getImportById,
  getImports,
  getOptions,
  postImport,
  postPreview,
  postRun,
  postTemplate,
  postUndo,
  removeTemplate,
} from '../controllers/imports.controller.js';
import { MAX_IMPORT_BYTES } from '../constants/importFields.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { authorize } from '../middleware/authorize.js';
import { singleFileUpload } from '../middleware/upload.js';
import { validate } from '../middleware/validate.js';
import { idParams } from '../validation/common.js';
import {
  listImportsQuery,
  previewImportBody,
  saveTemplateBody,
  startImportBody,
  uploadImportBody,
} from '../validation/imports.js';

// CSV import. Looking needs imports:view; uploading, starting and undoing need imports:create.
// Which imports a person sees is decided again in the service (their scope).
const router = Router();

router.use(requireAuth);

router.get('/', authorize('imports', 'view'), validate({ query: listImportsQuery }), getImports);
router.get('/options', authorize('imports', 'view'), getOptions);
router.post(
  '/',
  authorize('imports', 'create'),
  singleFileUpload({ maxBytes: MAX_IMPORT_BYTES }),
  validate({ body: uploadImportBody }),
  postImport,
);
// Before the /:id routes, so "templates" is not read as an id.
router.post(
  '/templates',
  authorize('imports', 'create'),
  validate({ body: saveTemplateBody }),
  postTemplate,
);
router.delete(
  '/templates/:id',
  authorize('imports', 'create'),
  validate({ params: idParams }),
  removeTemplate,
);
router.get('/:id', authorize('imports', 'view'), validate({ params: idParams }), getImportById);
router.post(
  '/:id/preview',
  authorize('imports', 'create'),
  validate({ params: idParams, body: previewImportBody }),
  postPreview,
);
router.post(
  '/:id/run',
  authorize('imports', 'create'),
  validate({ params: idParams, body: startImportBody }),
  postRun,
);
router.post('/:id/undo', authorize('imports', 'create'), validate({ params: idParams }), postUndo);

export default router;
