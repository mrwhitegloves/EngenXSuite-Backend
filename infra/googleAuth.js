import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { env } from '../config/env.js';
import { signInWithGoogle } from '../services/auth.service.js';

// Google sign-in through Passport (a proven library; no hand-written OAuth).
// Passport's own session support is NOT used: after Google confirms the identity, the controller
// stores only the user id in our server-side session.

export const GOOGLE_CALLBACK_PATH = '/api/auth/google/callback';

/** Register the Google strategy once, at startup. */
export function configureGoogleAuth() {
  passport.use(
    // GoogleStrategy is the library's class; creating it here is the only way to use it.
    new GoogleStrategy(
      {
        clientID: env.GOOGLE_SIGNIN_CLIENT_ID,
        clientSecret: env.GOOGLE_SIGNIN_CLIENT_SECRET,
        // Must match an "Authorized redirect URI" of the OAuth client exactly.
        callbackURL: `${env.APP_URL}${GOOGLE_CALLBACK_PATH}`,
        scope: ['openid', 'email', 'profile'],
        // A random value kept in the session and checked on return; stops forged callbacks.
        state: true,
      },
      async (accessToken, refreshToken, profile, done) => {
        try {
          const primaryEmail = profile.emails?.[0];
          const result = await signInWithGoogle(
            {
              googleId: profile.id,
              email: primaryEmail?.value,
              emailVerified: primaryEmail?.verified !== false,
              name: profile.displayName,
              avatarUrl: profile.photos?.[0]?.value,
            },
            { workspaceDomain: env.WORKSPACE_DOMAIN },
          );
          done(null, result);
        } catch (error) {
          done(error);
        }
      },
    ),
  );
}

export { passport };
