import { Router } from 'express';
import {
  getFormOptions,
  getLeadById,
  getLeads,
  patchLead,
  postLead,
  postStage,
  removeLead,
} from '../controllers/opportunities.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { idParams } from '../validation/common.js';
import {
  changeStageBody,
  createLeadBody,
  listLeadsQuery,
  updateLeadBody,
} from '../validation/opportunities.js';

// Leads. authorize() answers "may this person do this at all"; whether THIS lead is inside
// their scope is checked in the service, which answers 404 when it is not (decision 0008).
const router = Router();
const FEATURE = 'opportunities';

router.use(requireAuth);

router.get('/', authorize(FEATURE, 'view'), validate({ query: listLeadsQuery }), getLeads);
router.get('/form-options', authorize(FEATURE, 'view'), getFormOptions);
router.post('/', authorize(FEATURE, 'create'), validate({ body: createLeadBody }), postLead);
router.get('/:id', authorize(FEATURE, 'view'), validate({ params: idParams }), getLeadById);
router.patch(
  '/:id',
  authorize(FEATURE, 'edit'),
  validate({ params: idParams, body: updateLeadBody }),
  patchLead,
);
// A stage change is an edit of the lead.
router.post(
  '/:id/stage',
  authorize(FEATURE, 'edit'),
  validate({ params: idParams, body: changeStageBody }),
  postStage,
);
router.delete('/:id', authorize(FEATURE, 'delete'), validate({ params: idParams }), removeLead);

export default router;
