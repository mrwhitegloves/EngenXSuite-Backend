import passport from 'passport';
import { env } from '../config/env.js';
import {
  WORKSPACE_STRATEGY,
  configureGoogleWorkspaceAuth,
  workspaceAuthOptions,
} from '../integrations/google/oauth.js';
import { sendOk } from '../lib/respond.js';
import {
  completeConnect,
  disconnectGoogle,
  getGoogleConnection,
  prepareConnect,
  updateSignature,
} from '../services/googleConnection.service.js';

// A person's own connection to Gmail and Calendar.
// Two of these are opened by the browser itself (the way to Google and back), so they answer
// with a redirect to the "Mail and calendar" page and a short reason code, never with details.

const backTo = (res, result) => res.redirect(`${env.APP_URL}/connections?google=${result}`);
// An app error's code → the reason code the page explains.
const REASONS = {
  FORBIDDEN: 'not_allowed',
  GOOGLE_NOT_CONFIGURED: 'not_set_up',
  GOOGLE_WRONG_DOMAIN: 'wrong_domain',
  GOOGLE_WRONG_ACCOUNT: 'wrong_account',
  GOOGLE_PERMISSION_MISSING: 'permission_missing',
};

// GET /api/integrations/google: my connection (never a token).
export async function getConnection(req, res) {
  sendOk(res, await getGoogleConnection(req.user));
}

// GET /api/integrations/google/connect: send my browser to Google to give the permission.
export function startConnect(req, res, next) {
  let options;
  try {
    options = workspaceAuthOptions(prepareConnect(req.user).loginHint);
  } catch (error) {
    return backTo(res, REASONS[error?.code] ?? 'failed');
  }
  configureGoogleWorkspaceAuth();
  return passport.authenticate(WORKSPACE_STRATEGY, options)(req, res, next);
}

// GET /api/integrations/google/callback: Google sends my browser back here.
export function finishConnect(req, res, next) {
  configureGoogleWorkspaceAuth();
  passport.authenticate(WORKSPACE_STRATEGY, { session: false }, (error, grant) => {
    if (error || !grant) {
      // "access_denied": the person pressed Cancel on Google's screen.
      if (req.query.error === 'access_denied') return backTo(res, 'cancelled');
      req.log.warn({ err: error }, 'Google connection failed');
      return backTo(res, 'failed');
    }
    return completeConnect(req.user, grant, { requestId: req.id })
      .then(() => backTo(res, 'connected'))
      .catch((problem) => {
        const reason = REASONS[problem?.code];
        if (!reason) req.log.warn({ err: problem }, 'Google connection failed');
        backTo(res, reason ?? 'failed');
      });
  })(req, res, next);
}

// DELETE /api/integrations/google: take my connection away.
export async function removeConnection(req, res) {
  sendOk(res, await disconnectGoogle(req.user, { requestId: req.id }));
}

// PATCH /api/integrations/google/signature: the lines under my mails.
export async function patchSignature(req, res) {
  sendOk(res, await updateSignature(req.user, req.validated.body));
}
