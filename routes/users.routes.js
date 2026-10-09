import { Router } from 'express';
import {
  deleteAvatar,
  getFormOptions,
  getPassword,
  getUsers,
  patchUser,
  postAvatar,
  postUser,
} from '../controllers/users.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { authorize } from '../middleware/authorize.js';
import { createPasswordViewLimiter } from '../middleware/rateLimit.js';
import { MAX_AVATAR_BYTES, singleFileUpload } from '../middleware/upload.js';
import { validate } from '../middleware/validate.js';
import { idParams } from '../validation/common.js';
import { createUserBody, listUsersQuery, updateUserBody } from '../validation/users.js';

// User accounts. Only roles holding the "users" permission reach these (CEO: everyone,
// Sales Manager: their own team). Which users exactly is decided again in the service.
const router = Router();

router.use(requireAuth);

router.get('/', authorize('users', 'view'), validate({ query: listUsersQuery }), getUsers);
router.get('/form-options', authorize('users', 'create'), getFormOptions);
router.post('/', authorize('users', 'create'), validate({ body: createUserBody }), postUser);
router.patch(
  '/:id',
  authorize('users', 'edit'),
  validate({ params: idParams, body: updateUserBody }),
  patchUser,
);
router.post(
  '/:id/avatar',
  authorize('users', 'edit'),
  validate({ params: idParams }),
  singleFileUpload({ maxBytes: MAX_AVATAR_BYTES }),
  postAvatar,
);
router.delete(
  '/:id/avatar',
  authorize('users', 'edit'),
  validate({ params: idParams }),
  deleteAvatar,
);
router.get(
  '/:id/password',
  authorize('users', 'edit'),
  createPasswordViewLimiter(),
  validate({ params: idParams }),
  getPassword,
);

export default router;
