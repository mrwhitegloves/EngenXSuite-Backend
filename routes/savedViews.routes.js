import { Router } from 'express';
import {
  getSavedViews,
  postSavedView,
  removeSavedView,
} from '../controllers/savedViews.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import { idParams } from '../validation/common.js';
import { createSavedViewBody, listSavedViewsQuery } from '../validation/savedViews.js';

// Saved views: every signed-in user manages their own. There is no permission to grant, because
// a view holds only that user's own filter choices; the service limits every call to the owner.
const router = Router();

router.use(requireAuth);

router.get('/', validate({ query: listSavedViewsQuery }), getSavedViews);
router.post('/', validate({ body: createSavedViewBody }), postSavedView);
router.delete('/:id', validate({ params: idParams }), removeSavedView);

export default router;
