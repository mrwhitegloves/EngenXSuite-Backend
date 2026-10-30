import { Router } from 'express';
import {
  deleteThumbnail,
  getLinks,
  patchLink,
  postLink,
  postThumbnail,
  removeLink,
} from '../controllers/links.controller.js';
import { authorize } from '../middleware/authorize.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import { MAX_AVATAR_BYTES, singleFileUpload } from '../middleware/upload.js';
import { idParams } from '../validation/common.js';
import { createLinkBody, listLinksQuery, updateLinkBody } from '../validation/links.js';

// /api/links: the Links screen (feature "links": CEO by default; others via Settings → Roles).
const FEATURE = 'links';

const router = Router();
router.use(requireAuth);
router.get('/', authorize(FEATURE, 'view'), validate({ query: listLinksQuery }), getLinks);
router.post('/', authorize(FEATURE, 'create'), validate({ body: createLinkBody }), postLink);
router.patch(
  '/:id',
  authorize(FEATURE, 'edit'),
  validate({ params: idParams, body: updateLinkBody }),
  patchLink,
);
router.delete('/:id', authorize(FEATURE, 'delete'), validate({ params: idParams }), removeLink);
router.post(
  '/:id/thumbnail',
  authorize(FEATURE, 'edit'),
  validate({ params: idParams }),
  singleFileUpload({ maxBytes: MAX_AVATAR_BYTES }),
  postThumbnail,
);
router.delete(
  '/:id/thumbnail',
  authorize(FEATURE, 'edit'),
  validate({ params: idParams }),
  deleteThumbnail,
);

export default router;
