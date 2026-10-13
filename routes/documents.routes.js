import { Router } from 'express';
import {
  getDocuments,
  getFolders,
  patchDocument,
  patchFolder,
  postDocument,
  postFolder,
  removeDocument,
  removeFolder,
} from '../controllers/documents.controller.js';
import { authorize } from '../middleware/authorize.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { singleFileUpload } from '../middleware/upload.js';
import { validate } from '../middleware/validate.js';
import { MAX_DOCUMENT_BYTES } from '../services/documents.service.js';
import { idParams } from '../validation/common.js';
import {
  browseDocumentsQuery,
  createFolderBody,
  renameFolderBody,
  updateDocumentBody,
  uploadDocumentBody,
} from '../validation/documents.js';

// The documents library (/api/documents): one for the whole CRM. The "documents" permission
// decides: view (look, download, send with a mail), create (add), edit (rename, move, delete).
const router = Router();
const FEATURE = 'documents';
const byId = validate({ params: idParams });

router.use(requireAuth);
router.get(
  '/',
  authorize(FEATURE, 'view'),
  validate({ query: browseDocumentsQuery }),
  getDocuments,
);
router.get('/folders', authorize(FEATURE, 'view'), getFolders);
router.post(
  '/folders',
  authorize(FEATURE, 'create'),
  validate({ body: createFolderBody }),
  postFolder,
);
router.patch(
  '/folders/:id',
  authorize(FEATURE, 'edit'),
  validate({ params: idParams, body: renameFolderBody }),
  patchFolder,
);
router.delete('/folders/:id', authorize(FEATURE, 'edit'), byId, removeFolder);
router.post(
  '/',
  authorize(FEATURE, 'create'),
  // The file first: the form fields next to it are read by the same step.
  singleFileUpload({ maxBytes: MAX_DOCUMENT_BYTES }),
  validate({ body: uploadDocumentBody }),
  postDocument,
);
router.patch(
  '/:id',
  authorize(FEATURE, 'edit'),
  validate({ params: idParams, body: updateDocumentBody }),
  patchDocument,
);
router.delete('/:id', authorize(FEATURE, 'edit'), byId, removeDocument);

export default router;
