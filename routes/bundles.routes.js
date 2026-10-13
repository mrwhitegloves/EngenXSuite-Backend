import { Router } from 'express';
import {
  getBundleById,
  getBundles,
  getCandidates,
  patchBundle,
  postBundle,
  postMembers,
  removeBundle,
  removeMember,
} from '../controllers/bundles.controller.js';
import { authorize } from '../middleware/authorize.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import { idParams } from '../validation/common.js';
import {
  addMembersBody,
  bundleMembersQuery,
  candidatesQuery,
  createBundleBody,
  listBundlesQuery,
  memberParams,
  renameBundleBody,
} from '../validation/bundles.js';

// Bundles (/api/bundles): lists of people and companies for bulk sending. They belong to the
// "campaigns" permission; which bundle exactly is decided in the service.
const router = Router();
const FEATURE = 'campaigns';

router.use(requireAuth);
router.get('/', authorize(FEATURE, 'view'), validate({ query: listBundlesQuery }), getBundles);
router.post('/', authorize(FEATURE, 'create'), validate({ body: createBundleBody }), postBundle);
router.get(
  '/:id',
  authorize(FEATURE, 'view'),
  validate({ params: idParams, query: bundleMembersQuery }),
  getBundleById,
);
router.patch(
  '/:id',
  authorize(FEATURE, 'edit'),
  validate({ params: idParams, body: renameBundleBody }),
  patchBundle,
);
router.delete('/:id', authorize(FEATURE, 'edit'), validate({ params: idParams }), removeBundle);
router.get(
  '/:id/candidates',
  authorize(FEATURE, 'view'),
  validate({ params: idParams, query: candidatesQuery }),
  getCandidates,
);
router.post(
  '/:id/members',
  authorize(FEATURE, 'edit'),
  validate({ params: idParams, body: addMembersBody }),
  postMembers,
);
router.delete(
  '/:id/members/:memberId',
  authorize(FEATURE, 'edit'),
  validate({ params: memberParams }),
  removeMember,
);

export default router;
