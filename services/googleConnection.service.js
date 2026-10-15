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
import { can } from '../lib/can.js';
import { conflict, createAppError, forbidden } from '../lib/errors.js';
import { open, seal } from '../lib/secretBox.js';
import { User } from '../models/user.model.js';
import { UserGoogleConnection } from '../models/userGoogleConnection.model.js';

// The company mailbox: ONE Gmail and Google Calendar (for example kunal@engenx.in) that the
// whole CRM uses for mail and meetings (founder decision 2026-10-15, decision 0014). It is
// connected once, by someone who may change the settings, and every user works with it.
//
// RULES, checked here on the server:
//   - only someone with the "settings" edit permission connects, changes or removes it;
//   - only a Google account of the company's Workspace domain can be the company mailbox;
//   - there is at most one: connecting another one replaces it.
// Who sees which mail is decided by the CRM's access rules (services/emails.service.js).
//
// Tokens are stored sealed, are never logged, never audited and never part of an answer.
// Other code gets a token only through getGoogleAccessToken().

// The scopes without which nothing works.
const NEEDED_SCOPES = WORKSPACE_SCOPES.filter((scope) => scope.startsWith('https://'));
const onDomain = (email) =>
  String(email ?? '')
    .toLowerCase()
    .endsWith(`@${env.WORKSPACE_DOMAIN.toLowerCase()}`);

/** May this person connect, change or remove the company mailbox? */
export const mayManageMailbox = (actor) => can(actor, 'edit', { feature: 'settings' });

function assertMayManage(actor) {
  if (!isGoogleWorkspaceConfigured()) {
    throw createAppError(
      'GOOGLE_NOT_CONFIGURED',
      503,
      'Connecting Gmail and Calendar is not set up yet.',
    );
  }
  if (!mayManageMailbox(actor)) {
    throw forbidden('Only someone who manages the settings can connect the company mailbox.');
  }
}

/**
 * The company mailbox, or null when none is connected. Holds no token.
 * @returns {Promise<{ _id: unknown, userId: unknown, googleEmail: string, status: string } | null>}
 */
export async function getCompanyMailbox() {
  return UserGoogleConnection.findOne().sort({ connectedAt: -1 }).lean();
}

/** True when the company mailbox is connected and working. */
export async function isCompanyMailboxConnected() {
  return Boolean(await UserGoogleConnection.exists({ status: 'connected' }));
}

/** Called before the browser is sent to Google. */
export async function prepareConnect(actor) {
  assertMayManage(actor);
  const mailbox = await getCompanyMailbox();
  // Google's screen offers the mailbox that is connected now, when there is one.
  return { loginHint: mailbox?.googleEmail };
}

/** What a person sees about the company mailbox. No token, ever. */
export async function getGoogleConnection(actor) {
  const connection = await getCompanyMailbox();
  const by = connection?.connectedBy
    ? await User.findById(connection.connectedBy).select('name').lean()
    : null;
  return {
    isConfigured: isGoogleWorkspaceConfigured(),
    missing: missingGoogleWorkspaceSettings(),
    workspaceDomain: env.WORKSPACE_DOMAIN,
    // Only someone who manages the settings connects or removes it.
    mayConnect: mayManageMailbox(actor),
    connection: connection
      ? {
          googleEmail: connection.googleEmail,
          status: connection.status,
          connectedAt: connection.connectedAt,
          connectedBy: by?.name ?? null,
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
 * Google sent the browser back with the permission: check it and keep it as the company
 * mailbox. The same mailbox connected again keeps where its reading stood; another mailbox
 * replaces it (the mail already in the CRM stays).
 * @param {{ accessToken: string, refreshToken?: string, expiresInSec: number, scopes: string[],
 *           googleEmail: string | null, hostedDomain: string | null }} grant  From Google
 * @returns {Promise<void>}  Throws an app error whose `code` says why it was refused
 */
export async function completeConnect(actor, grant, context = {}) {
  assertMayManage(actor);
  const refuse = async (code, message) => {
    // The permission was given to us but we will not use it: give it back.
    await revokeToken(grant.refreshToken ?? grant.accessToken);
    throw createAppError(code, 403, message);
  };
  if (!grant.googleEmail || !onDomain(grant.googleEmail)) {
    await refuse('GOOGLE_WRONG_DOMAIN', `Choose a ${env.WORKSPACE_DOMAIN} Google account.`);
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

  const tokens = {
    scopes: grant.scopes,
    refreshToken: seal(grant.refreshToken),
    accessToken: seal(grant.accessToken),
    accessTokenExpiresAt: new Date(Date.now() + grant.expiresInSec * 1000),
    status: 'connected',
    connectedAt: new Date(),
    connectedBy: actor._id,
  };
  const current = await getCompanyMailbox();
  let mailbox;
  if (current && current.googleEmail === grant.googleEmail) {
    // The same mailbox again: its mail stays where it is and its reading goes on.
    mailbox = await UserGoogleConnection.findOneAndUpdate(
      { _id: current._id },
      { $set: tokens, $unset: { lastError: '' } },
      { returnDocument: 'after' },
    ).lean();
  } else {
    // Another mailbox: the one before is let go (Google is told), then this one is kept.
    await letGoAll();
    mailbox = (
      await UserGoogleConnection.create({
        ...tokens,
        // The mailbox is kept under the person who connected it; its mail is stored with that
        // id, so it stays the same when the same mailbox is connected again later.
        userId: actor._id,
        googleEmail: grant.googleEmail,
      })
    ).toObject();
  }
  await writeAudit({
    actor,
    action: 'google.connected',
    entityType: 'user_google_connections',
    entityId: mailbox._id,
    newValue: { googleEmail: grant.googleEmail, companyMailbox: true },
    requestId: context.requestId,
  });
  // Read the mailbox for the first time, in the background. Without a queue, "Read the mailbox
  // now" in the Inbox does it.
  await enqueue('messaging', JOB_NAMES.emailSync, { userId: String(mailbox.userId) }).catch(
    () => {},
  );
}

/** Every stored connection is removed; Google is told about each one it can be told about. */
async function letGoAll() {
  const all = await UserGoogleConnection.find().select('+refreshToken').lean();
  for (const connection of all) {
    let token;
    try {
      token = open(connection.refreshToken);
    } catch {
      // Sealed with another key: nothing to tell Google with; our copy still goes.
    }
    if (token) await revokeToken(token);
  }
  await UserGoogleConnection.deleteMany({});
  return all;
}

/** Take the company mailbox away: Google is told, and our copy of the tokens is deleted. */
export async function disconnectGoogle(actor, context = {}) {
  assertMayManage(actor);
  const removed = await letGoAll();
  if (removed.length > 0) {
    await writeAudit({
      actor,
      action: 'google.disconnected',
      entityType: 'user_google_connections',
      entityId: removed[0]._id,
      oldValue: { googleEmail: removed[0].googleEmail, companyMailbox: true },
      requestId: context.requestId,
    });
  }
  return getGoogleConnection(actor);
}

/**
 * A working access token of the company mailbox, for the Gmail and Calendar code. Refreshed
 * when it is about to run out. When Google refuses for good, the mailbox is marked
 * "needs_reconnect".
 * @returns {Promise<string>}  Throws when the company mailbox is not connected
 */
export async function getGoogleAccessToken() {
  const connection = await UserGoogleConnection.findOne()
    .sort({ connectedAt: -1 })
    .select('+refreshToken +accessToken')
    .lean();
  if (!connection || connection.status !== 'connected') {
    throw createAppError(
      'GOOGLE_NOT_CONNECTED',
      409,
      'The company mailbox (Gmail and Calendar) is not connected.',
    );
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

/** The lines under every mail of the company mailbox. */
export async function updateSignature(actor, { signature }) {
  assertMayManage(actor);
  const mailbox = await getCompanyMailbox();
  if (!mailbox) {
    throw createAppError(
      'GOOGLE_NOT_CONNECTED',
      409,
      'The company mailbox (Gmail and Calendar) is not connected.',
    );
  }
  await UserGoogleConnection.updateOne({ _id: mailbox._id }, { $set: { signature } });
  return getGoogleConnection(actor);
}
