import { Router } from 'express';
import {
  finishGoogleSignIn,
  getCurrentUser,
  logout,
  startGoogleSignIn,
  updateCurrentUser,
} from '../controllers/auth.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import { updateMyPreferencesBody } from '../validation/auth.js';

const router = Router();

router.get('/google', startGoogleSignIn);
router.get('/google/callback', finishGoogleSignIn);
router.get('/me', requireAuth, getCurrentUser);
router.patch('/me', requireAuth, validate({ body: updateMyPreferencesBody }), updateCurrentUser);
router.post('/logout', logout);

export default router;
