import { env } from '../config/env.js';
import {
  WORKSPACE_SCOPES,
  isGoogleWorkspaceConfigured,
  missingGoogleWorkspaceSettings,
  refreshAccessToken,
  revokeToken,
} from '../integrations/google/oauth.js';
import { JOB_NAMES } from '../constants/jobNames.js';
import { enqueue } from '../infra/queues.js';
import { writeAudit } from '../lib/audit.js';
import { conflict, createAppError, forbidden } from '../lib/errors.js';
import { open, seal } from '../lib/secretBox.js';
import { UserGoogleConnection } from '../models/userGoogleConnection.model.js';

// A person's connection to their own Gmail and Calendar.
//
// HARD RULE (REQ-USR-008): only an account of the company's Workspace domain may connect, and
// only its OWN mailbox. Both are checked here, on the server, at every step: who is asking, and
// which Google account gave the permission. A normal Gmail user can sign in and work, but can
// never connect mail or calendar.
//
// Tokens are stored sealed, are never logged, never audited and never part of an answer.

// The scopes without which nothing of this phase works.
const NEEDED_SCOPES = WORKSPACE_SCOPES.filter((scope) => scope.startsWith('https://'));
const onDomain = (email) =>
  String(email ?? '')
    .toLowerCase()
    .endsWith(`@${env.WORKSPACE_DOMAIN.toLowerCase()}`);

/** May this person connect at all? (Their CRM login is a company address.) */
export const mayConnectGoogle = (actor) =>
  Boolean(actor.isWorkspaceAccount) && onDomain(actor.email);

function assertMayConnect(actor) {
  if (!isGoogleWorkspaceConfigured()) {
    throw createAppError(
      'GOOGLE_NOT_CONFIGURED',
      503,
      'Connecting Gmail and Calendar is not set up yet.',
    );
  }
  if (!mayConnectGoogle(actor)) {
    throw forbidden(`Only ${env.WORKSPACE_DOMAIN} accounts can connect Gmail and Calendar.`);
  }
}

/** Called before the browser is sent to Google. */
export function prepareConnect(actor) {
  assertMayConnect(actor);
  return { loginHint: actor.email };
}

/** What the person sees about their connection. No token, ever. */
export async function getGoogleConnection(actor) {
  const connection = await UserGoogleConnection.findOne({ userId: actor._id }).lean();
  return {
    isConfigured: isGoogleWorkspaceConfigured(),
    missing: missingGoogleWorkspaceSettings(),
    workspaceDomain: env.WORKSPACE_DOMAIN,
    mayConnect: mayConnectGoogle(actor),
    connection: connection
      ? {
          googleEmail: connection.googleEmail,
          status: connection.status,
          connectedAt: connection.connectedAt,
          lastError: connection.lastError ?? null,
          hasMail: connection.scopes.some((scope) => scope.includes('gmail')),
          hasCalendar: connection.scopes.some((scope) => scope.includes('calendar')),
          mailLastSyncAt: connection.gmail?.lastSyncAt ?? null,
          signature: connection.signature ?? '',
          // New mail is pushed by Google until then; empty: read every three minutes.
          mailPushUntil: connection.gmail?.watchExpiresAt ?? null,
        }
      : null,
  };
}

/**
 * Google sent the person back with their permission: check it and keep it.
 * @param {{ accessToken: string, refreshToken?: string, expiresInSec: number, scopes: string[],
 *           googleEmail: string | null, hostedDomain: string | null }} grant  From Google
 * @returns {Promise<void>}  Throws an app error whose `code` says why it was refused
 */
export async function completeConnect(actor, grant, context = {}) {
  assertMayConnect(actor);
  const refuse = async (code, message) => {
    // The permission was given to us but we will not use it: give it back.
    await revokeToken(grant.refreshToken ?? grant.accessToken);
    throw createAppError(code, 403, message);
  };
  if (!grant.googleEmail || !onDomain(grant.googleEmail)) {
    await refuse('GOOGLE_WRONG_DOMAIN', `Choose your ${env.WORKSPACE_DOMAIN} Google account.`);
  }
  if (grant.googleEmail !== actor.email.toLowerCase()) {
    await refuse('GOOGLE_WRONG_ACCOUNT', `You can connect only your own mailbox (${actor.email}).`);
  }
  const missing = NEEDED_SCOPES.filter((scope) => !grant.scopes.includes(scope));
  if (missing.length > 0) {
    await refuse(
      'GOOGLE_PERMISSION_MISSING',
      'Tick both boxes on Google’s screen: mail and calendar are both needed.',
    );
  }
  if (!grant.refreshToken) {
    throw conflict('Google sent no lasting permission. Try to connect again.');
  }

  await UserGoogleConnection.findOneAndUpdate(
    { userId: actor._id },
    {
      $set: {
        googleEmail: grant.googleEmail,
        scopes: grant.scopes,
        refreshToken: seal(grant.refreshToken),
        accessToken: seal(grant.accessToken),
        accessTokenExpiresAt: new Date(Date.now() + grant.expiresInSec * 1000),
        status: 'connected',
        connectedAt: new Date(),
      },
      $unset: { lastError: '' },
    },
    { upsert: true },
  );
  await writeAudit({
    actor,
    action: 'google.connected',
    entityType: 'users',
    entityId: actor._id,
    newValue: { googleEmail: grant.googleEmail },
    requestId: context.requestId,
  });
  // Read the mailbox for the first time, in the background. Without a queue the person can
  // press "Read my mailbox now" in the Inbox.
  await enqueue('messaging', JOB_NAMES.emailSync, { userId: String(actor._id) }).catch(() => {});
}

/** Take the connection away: Google is told, and our copy of the tokens is deleted. */
export async function disconnectGoogle(actor, context = {}) {
  const connection = await UserGoogleConnection.findOne({ userId: actor._id })
    .select('+refreshToken')
    .lean();
  if (!connection) return getGoogleConnection(actor);
  let token;
  try {
    token = open(connection.refreshToken);
  } catch {
    // Sealed with another key: nothing to tell Google with; our copy still goes.
  }
  if (token) await revokeToken(token);
  await UserGoogleConnection.deleteOne({ _id: connection._id });
  await writeAudit({
    actor,
    action: 'google.disconnected',
    entityType: 'users',
    entityId: actor._id,
    oldValue: { googleEmail: connection.googleEmail },
    requestId: context.requestId,
  });
  return getGoogleConnection(actor);
}

/**
 * A working access token of one user, for the Gmail and Calendar code. Refreshed when it is
 * about to run out. When Google refuses for good, the connection is marked "needs_reconnect".
 * @returns {Promise<string>}  Throws when the user has no working connection
 */
export async function getGoogleAccessToken(userId) {
  const connection = await UserGoogleConnection.findOne({ userId })
    .select('+refreshToken +accessToken')
    .lean();
  if (!connection || connection.status !== 'connected') {
    throw createAppError('GOOGLE_NOT_CONNECTED', 409, 'Gmail and Calendar are not connected.');
  }
  const stillGood =
    connection.accessToken &&
    connection.accessTokenExpiresAt &&
    connection.accessTokenExpiresAt.getTime() - Date.now() > 60 * 1000;
  if (stillGood) return open(connection.accessToken);

  try {
    const fresh = await refreshAccessToken(open(connection.refreshToken));
    await UserGoogleConnection.updateOne(
      { _id: connection._id },
      {
        $set: {
          accessToken: seal(fresh.accessToken),
          accessTokenExpiresAt: new Date(Date.now() + fresh.expiresInSec * 1000),
        },
      },
    );
    return fresh.accessToken;
  } catch (error) {
    if (error?.code === 'GOOGLE_ACCESS_REVOKED') {
      await UserGoogleConnection.updateOne(
        { _id: connection._id },
        { $set: { status: 'needs_reconnect', lastError: error.message } },
      );
    }
    throw error;
  }
}

/** The lines a person puts under their mails. Kept with their connection. */
export async function updateSignature(actor, { signature }) {
  const result = await UserGoogleConnection.updateOne(
    { userId: actor._id },
    { $set: { signature } },
  );
  if (result.matchedCount === 0) {
    throw createAppError('GOOGLE_NOT_CONNECTED', 409, 'Gmail and Calendar are not connected.');
  }
  return getGoogleConnection(actor);
}
