import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { env } from '../../config/env.js';
import { createAppError } from '../../lib/errors.js';
import { isSecretBoxReady } from '../../lib/secretBox.js';

// The only file that talks to Google about a person's permission to use their Gmail and
// Calendar. This is NOT the sign-in (infra/googleAuth.js): it uses a second OAuth client, of an
// INTERNAL Google Cloud project of the company's Workspace, so only people of the company can
// give this permission and Google asks for no review. Setup: docs/EMAIL.md.

export const WORKSPACE_STRATEGY = 'google-workspace';
export const WORKSPACE_CALLBACK_PATH = '/api/integrations/google/callback';

// What we ask for: read and send mail (never permanent deletion), and the person's events.
export const WORKSPACE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.events',
];
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export function isGoogleWorkspaceConfigured() {
  return Boolean(
    env.GOOGLE_WORKSPACE_CLIENT_ID && env.GOOGLE_WORKSPACE_CLIENT_SECRET && isSecretBoxReady(),
  );
}

/** The names of the settings that are still missing (names only, for the screen). */
export function missingGoogleWorkspaceSettings() {
  return [
    !env.GOOGLE_WORKSPACE_CLIENT_ID && 'GOOGLE_WORKSPACE_CLIENT_ID',
    !env.GOOGLE_WORKSPACE_CLIENT_SECRET && 'GOOGLE_WORKSPACE_CLIENT_SECRET',
    !isSecretBoxReady() && 'ENCRYPTION_KEY',
  ].filter(Boolean);
}

let isRegistered = false;
/** Register the Passport strategy once. Safe to call again. */
export function configureGoogleWorkspaceAuth() {
  if (isRegistered || !isGoogleWorkspaceConfigured()) return;
  passport.use(
    WORKSPACE_STRATEGY,
    // GoogleStrategy is the library's class; creating it here is the only way to use it.
    new GoogleStrategy(
      {
        clientID: env.GOOGLE_WORKSPACE_CLIENT_ID,
        clientSecret: env.GOOGLE_WORKSPACE_CLIENT_SECRET,
        // Must match an "Authorised redirect URI" of the OAuth client exactly.
        callbackURL: `${env.APP_URL}${WORKSPACE_CALLBACK_PATH}`,
        scope: WORKSPACE_SCOPES,
        // A random value kept in the session and checked on return; stops forged callbacks.
        state: true,
      },
      // Nothing is decided here: the tokens and the Google account go to the service, which
      // checks them against the signed-in person.
      (accessToken, refreshToken, params, profile, done) =>
        done(null, {
          accessToken,
          refreshToken,
          expiresInSec: Number(params?.expires_in ?? 3600),
          scopes: String(params?.scope ?? '')
            .split(' ')
            .filter(Boolean),
          googleEmail: profile.emails?.[0]?.value?.toLowerCase() ?? null,
          hostedDomain: profile._json?.hd ?? null,
        }),
    ),
  );
  isRegistered = true;
}

/** What Google is told when a person is sent there to give the permission. */
export const workspaceAuthOptions = (loginHint) => ({
  session: false,
  // "offline": we get a refresh token, to work when the person is not at the screen.
  // "consent": always ask, so Google always sends that refresh token.
  accessType: 'offline',
  prompt: 'consent',
  // Only accounts of the company's Workspace, and by default the person's own.
  hostedDomain: env.WORKSPACE_DOMAIN,
  loginHint,
});

async function post(url, fields) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw createAppError('GOOGLE_UNREACHABLE', 502, 'Google could not be reached. Try again.');
  }
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, body };
}

/**
 * A fresh access token from a refresh token.
 * @returns {Promise<{ accessToken: string, expiresInSec: number }>}
 *          Throws GOOGLE_ACCESS_REVOKED when the person (or their admin) took the permission away.
 */
export async function refreshAccessToken(refreshToken) {
  const { ok, body } = await post(TOKEN_URL, {
    client_id: env.GOOGLE_WORKSPACE_CLIENT_ID,
    client_secret: env.GOOGLE_WORKSPACE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  if (!ok || !body.access_token) {
    if (body.error === 'invalid_grant') {
      throw createAppError(
        'GOOGLE_ACCESS_REVOKED',
        409,
        'Google no longer allows access to this mailbox. Connect it again.',
      );
    }
    throw createAppError('GOOGLE_ERROR', 502, 'Google refused the request. Try again later.');
  }
  return { accessToken: body.access_token, expiresInSec: Number(body.expires_in ?? 3600) };
}

/** Tell Google the permission is given back. Never throws: disconnecting must always work. */
export async function revokeToken(token) {
  try {
    await post(REVOKE_URL, { token });
  } catch {
    // Google is not reachable: our copy of the token is deleted anyway.
  }
}
