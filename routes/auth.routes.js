import { Router } from 'express';
import {
  finishGoogleSignIn,
  getCurrentUser,
  logout,
  startGoogleSignIn,
} from '../controllers/auth.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

router.get('/google', startGoogleSignIn);
router.get('/google/callback', finishGoogleSignIn);
router.get('/me', requireAuth, getCurrentUser);
router.post('/logout', logout);

export default router;
