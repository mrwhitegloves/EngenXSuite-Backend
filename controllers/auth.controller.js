import { env } from '../config/env.js';
import { passport } from '../infra/googleAuth.js';
import { SESSION_COOKIE_NAME } from '../middleware/session.js';
import {
  loadRequestUser,
  resetPasswordByEmail,
  signInWithPassword,
  toPublicUser,
  updateMyPreferences,
} from '../services/auth.service.js';
import { removeAvatar, saveAvatar } from '../services/avatar.service.js';
import { isAppError } from '../lib/errors.js';
import { sendOk } from '../lib/respond.js';

// Put the user into a brand-new session. A new session id after sign-in means an id an attacker
// may have planted in the browser beforehand is useless.
function startSession(req, userId) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((regenerateError) => {
      if (regenerateError) return reject(regenerateError);
      req.session.userId = userId;
      return req.session.save((saveError) => (saveError ? reject(saveError) : resolve()));
    });
  });
}

// POST /api/auth/login: email + password sign-in.
export async function loginWithPassword(req, res) {
  const { userId } = await signInWithPassword(req.validated.body);
  await startSession(req, userId);
  sendOk(res, toPublicUser(await loadRequestUser(userId)));
}

// POST /api/auth/reset-password: "forgot password" from the sign-in page. The email of an
// existing user plus a new password; no email is sent and the old password is not asked.
export async function resetPassword(req, res) {
  await resetPasswordByEmail(req.validated.body, { requestId: req.id });
  sendOk(res, { reset: true });
}

// GET /api/auth/google: send the browser to Google's sign-in page.
export const startGoogleSignIn = passport.authenticate('google', { session: false });

// GET /api/auth/google/callback: Google sends the browser back here.
// On success the user id goes into our session and the browser returns to the app.
// On failure the browser returns to the sign-in page with a short reason code (never details).
export function finishGoogleSignIn(req, res, next) {
  passport.authenticate('google', { session: false }, (error, result) => {
    if (error || !result) {
      const reason = isAppError(error) && error.status === 403 ? 'not_invited' : 'failed';
      if (reason === 'failed') req.log.warn({ err: error }, 'Google sign-in failed');
      return res.redirect(`${env.APP_URL}/?signin=${reason}`);
    }
    return startSession(req, result.userId)
      .then(() => res.redirect(`${env.APP_URL}/`))
      .catch(next);
  })(req, res, next);
}

// GET /api/auth/me: who is signed in, and what may they do.
export function getCurrentUser(req, res) {
  sendOk(res, toPublicUser(req.user));
}

// PATCH /api/auth/me: the signed-in user changes their own preferences (theme).
export async function updateCurrentUser(req, res) {
  const user = await updateMyPreferences(req.user._id, req.validated.body);
  sendOk(res, toPublicUser(user));
}

// POST /api/auth/me/avatar: the signed-in user uploads their own profile picture.
export async function uploadMyAvatar(req, res) {
  await saveAvatar({ actor: req.user, userId: req.user._id, file: req.file, requestId: req.id });
  sendOk(res, toPublicUser(await loadRequestUser(req.user._id)));
}

// DELETE /api/auth/me/avatar: the signed-in user removes their own profile picture.
export async function deleteMyAvatar(req, res) {
  await removeAvatar({ actor: req.user, userId: req.user._id, requestId: req.id });
  sendOk(res, toPublicUser(await loadRequestUser(req.user._id)));
}

// POST /api/auth/logout: end the session on the server and clear the cookie.
export function logout(req, res, next) {
  if (!req.session) return sendOk(res, { signedOut: true });
  return req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie(SESSION_COOKIE_NAME);
    return sendOk(res, { signedOut: true });
  });
}
