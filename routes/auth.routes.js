import { Router } from 'express';
import {
  deleteMyAvatar,
  finishGoogleSignIn,
  getCurrentUser,
  loginWithPassword,
  logout,
  resetPassword,
  startGoogleSignIn,
  updateCurrentUser,
  uploadMyAvatar,
} from '../controllers/auth.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { createLoginLimiter, createPasswordResetLimiter } from '../middleware/rateLimit.js';
import { MAX_AVATAR_BYTES, singleFileUpload } from '../middleware/upload.js';
import { validate } from '../middleware/validate.js';
import { loginBody, resetPasswordBody, updateMyPreferencesBody } from '../validation/auth.js';

const router = Router();

// Email + password. The limiters run after validation so they can count per email address.
router.post('/login', validate({ body: loginBody }), createLoginLimiter(), loginWithPassword);

// Forgot password: email of an existing user + new password (decision 0011).
router.post(
  '/reset-password',
  validate({ body: resetPasswordBody }),
  createPasswordResetLimiter(),
  resetPassword,
);

router.get('/google', startGoogleSignIn);
router.get('/google/callback', finishGoogleSignIn);

router.get('/me', requireAuth, getCurrentUser);
router.patch('/me', requireAuth, validate({ body: updateMyPreferencesBody }), updateCurrentUser);
router.post(
  '/me/avatar',
  requireAuth,
  singleFileUpload({ maxBytes: MAX_AVATAR_BYTES }),
  uploadMyAvatar,
);
router.delete('/me/avatar', requireAuth, deleteMyAvatar);
router.post('/logout', logout);

export default router;
