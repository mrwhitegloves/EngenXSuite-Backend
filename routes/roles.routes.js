import { Router } from 'express';
import { getRoles, patchRole, postRole, removeRole } from '../controllers/roles.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { idParams } from '../validation/common.js';
import { createRoleBody, updateRoleBody } from '../validation/roles.js';

// Account types and their permissions (Settings → Roles and permissions).
// Needs the "settings" permission, which by default only the CEO account type holds.
const router = Router();

router.use(requireAuth);

router.get('/', authorize('settings', 'view'), getRoles);
router.post('/', authorize('settings', 'edit'), validate({ body: createRoleBody }), postRole);
router.patch(
  '/:id',
  authorize('settings', 'edit'),
  validate({ params: idParams, body: updateRoleBody }),
  patchRole,
);
router.delete('/:id', authorize('settings', 'edit'), validate({ params: idParams }), removeRole);

export default router;
