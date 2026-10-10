import { Router } from 'express';
import {
  getTags,
  patchTag,
  postMergeTag,
  postTag,
  removeTag,
} from '../controllers/tags.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { idParams } from '../validation/common.js';
import { createTagBody, listTagsQuery, mergeTagBody, updateTagBody } from '../validation/tags.js';

// Tags. Reading is open to every signed-in user (the pickers need the names). Creating,
// renaming, merging and deleting change what everyone sees, so they need the "settings"
// permission. Putting a tag ON a record is part of editing that record.
const router = Router();

router.use(requireAuth);

router.get('/', validate({ query: listTagsQuery }), getTags);
router.post('/', authorize('settings', 'edit'), validate({ body: createTagBody }), postTag);
router.patch(
  '/:id',
  authorize('settings', 'edit'),
  validate({ params: idParams, body: updateTagBody }),
  patchTag,
);
router.post(
  '/:id/merge',
  authorize('settings', 'edit'),
  validate({ params: idParams, body: mergeTagBody }),
  postMergeTag,
);
router.delete('/:id', authorize('settings', 'edit'), validate({ params: idParams }), removeTag);

export default router;
