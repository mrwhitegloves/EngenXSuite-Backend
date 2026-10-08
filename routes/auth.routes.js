import { Router } from 'express';
import {
  changePassword,
  finishGoogleSignIn,
  forgotPassword,
  getCurrentUser,
  loginWithPassword,
  logout,
  resetPassword,
  startGoogleSignIn,
  updateCurrentUser,
} from '../controllers/auth.controller.js';
import { requireAuth, requireAuthAllowingPasswordChange } from '../middleware/requireAuth.js';
import {
  createLoginLimiter,
  createPasswordResetLimiter,
  createResetTokenLimiter,
} from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import {
  changeMyPasswordBody,
  forgotPasswordBody,
  loginBody,
  resetPasswordWithTokenBody,
  updateMyPreferencesBody,
} from '../validation/auth.js';

const router = Router();
const loginLimiter = createLoginLimiter();

// Email + password. The limiter runs after validation so it can count per email address.
router.post('/login', validate({ body: loginBody }), loginLimiter, loginWithPassword);

// Forgot password: ask for an emailed link, then use it.
router.post(
  '/forgot-password',
  validate({ body: forgotPasswordBody }),
  createPasswordResetLimiter(),
  forgotPassword,
);
router.post(
  '/reset-password',
  createResetTokenLimiter(),
  validate({ body: resetPasswordWithTokenBody }),
  resetPassword,
);

router.get('/google', startGoogleSignIn);
router.get('/google/callback', finishGoogleSignIn);

// These three stay reachable while a user still has to choose their own password.
router.get('/me', requireAuthAllowingPasswordChange, getCurrentUser);
router.post(
  '/password',
  requireAuthAllowingPasswordChange,
  validate({ body: changeMyPasswordBody }),
  changePassword,
);
router.post('/logout', logout);

router.patch('/me', requireAuth, validate({ body: updateMyPreferencesBody }), updateCurrentUser);

export default router;
