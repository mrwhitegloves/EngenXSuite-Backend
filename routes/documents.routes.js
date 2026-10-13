import { Router } from 'express';
import { getDocuments, postDocument, removeDocument } from '../controllers/documents.controller.js';
import { authorize } from '../middleware/authorize.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { singleFileUpload } from '../middleware/upload.js';
import { validate } from '../middleware/validate.js';
import { MAX_DOCUMENT_BYTES } from '../services/documents.service.js';
import { idParams } from '../validation/common.js';
import { listDocumentsQuery, uploadDocumentBody } from '../validation/documents.js';

// The documents of a company (/api/documents). authorize() answers "may this person use
// documents at all"; which company exactly is decided in the service.
const router = Router();
const FEATURE = 'documents';

router.use(requireAuth);
router.get('/', authorize(FEATURE, 'view'), validate({ query: listDocumentsQuery }), getDocuments);
router.post(
  '/',
  authorize(FEATURE, 'create'),
  // The file first: the form fields next to it are read by the same step.
  singleFileUpload({ maxBytes: MAX_DOCUMENT_BYTES }),
  validate({ body: uploadDocumentBody }),
  postDocument,
);
router.delete('/:id', authorize(FEATURE, 'edit'), validate({ params: idParams }), removeDocument);

export default router;
