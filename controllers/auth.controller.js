import { env } from '../config/env.js';
import { passport } from '../infra/googleAuth.js';
import { SESSION_COOKIE_NAME } from '../middleware/session.js';
import { toPublicUser, updateMyPreferences } from '../services/auth.service.js';
import { isAppError } from '../lib/errors.js';
import { sendOk } from '../lib/respond.js';

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

    // A new session id after sign-in, so an id an attacker may have planted before is useless.
    return req.session.regenerate((sessionError) => {
      if (sessionError) return next(sessionError);
      req.session.userId = result.userId;
      return req.session.save((saveError) => {
        if (saveError) return next(saveError);
        return res.redirect(`${env.APP_URL}/`);
      });
    });
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

// POST /api/auth/logout: end the session on the server and clear the cookie.
export function logout(req, res, next) {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie(SESSION_COOKIE_NAME);
    return sendOk(res, { signedOut: true });
  });
}
