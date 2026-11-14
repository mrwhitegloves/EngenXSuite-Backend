import { createHash, randomBytes, randomInt } from 'node:crypto';
import { RECORDER_SETTINGS } from '../config/meetingTranscripts.js';
import { writeAudit } from '../lib/audit.js';
import { badRequest, notFound, unauthorized } from '../lib/errors.js';
import { RecorderDevice } from '../models/recorderDevice.model.js';
import { loadRequestUser } from './auth.service.js';

// The meeting recorder (Chrome extension) connects to ONE user, without their password:
//   1. In the CRM the person asks for a pairing code (8 letters, 10 minutes, used once).
//   2. They type it into the extension, which trades it for its own long token.
//   3. The extension sends that token with every request ("Authorization: Bearer …").
// Only SHA-256 hashes of codes and tokens are stored. A person sees and disconnects their
// own recorders in the CRM; a deactivated user's recorder stops working at once, because the
// user is loaded fresh on every request (loadRequestUser).

// No 0/O, 1/I/L: the code is read from a screen and typed by hand.
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const TOKEN_PREFIX = 'rec_';
const DAY_MS = 24 * 60 * 60 * 1000;

const hashOf = (text) => createHash('sha256').update(String(text)).digest('hex');
/** A typed code: spaces and dashes are allowed, small letters too. */
export const normalizeCode = (code) =>
  String(code ?? '')
    .toUpperCase()
    .replace(/[\s-]+/g, '');

const deviceView = (device) => ({
  id: String(device._id),
  name: device.name || 'Meeting recorder',
  connectedAt: device.connectedAt,
  lastUsedAt: device.lastUsedAt ?? null,
});

const isUsable = (device, now) =>
  device.tokenHash &&
  !device.revokedAt &&
  now - (device.lastUsedAt ?? device.connectedAt).getTime() < RECORDER_SETTINGS.deviceIdleMs;

/** My connected recorders. */
export async function listMyRecorders(actor) {
  const now = Date.now();
  const devices = await RecorderDevice.find({ userId: actor._id, tokenHash: { $type: 'string' } })
    .sort({ connectedAt: -1 })
    .lean();
  return devices.filter((device) => isUsable(device, now)).map(deviceView);
}

/**
 * A new pairing code for me. Earlier unused codes of mine stop working.
 * @returns {Promise<{ code: string, expiresAt: Date }>}
 */
export async function createPairingCode(actor, context = {}) {
  const connected = await listMyRecorders(actor);
  if (connected.length >= RECORDER_SETTINGS.maxDevicesPerUser) {
    throw badRequest(
      `You have ${connected.length} recorders connected. Disconnect one you no longer use first.`,
    );
  }
  await RecorderDevice.deleteMany({ userId: actor._id, tokenHash: { $exists: false } });
  const code = Array.from(
    { length: RECORDER_SETTINGS.pairingCodeLength },
    () => CODE_LETTERS[randomInt(CODE_LETTERS.length)],
  ).join('');
  const expiresAt = new Date(Date.now() + RECORDER_SETTINGS.pairingCodeMs);
  await RecorderDevice.create({
    userId: actor._id,
    pairingCodeHash: hashOf(code),
    pairingExpiresAt: expiresAt,
  });
  await writeAudit({
    actor,
    action: 'recorder.pairing_code_created',
    entityType: 'recorder_devices',
    entityId: actor._id,
    requestId: context.requestId,
  });
  return { code, expiresAt };
}

/**
 * The extension trades a pairing code for its token. Used once; a wrong or old code gets the
 * same answer as an unknown one.
 * @param {{ code: string, deviceName?: string }} request  Validated
 * @returns {Promise<{ token: string, user: { name: string, email: string } }>}
 */
export async function pairRecorder({ code, deviceName }, context = {}) {
  const now = new Date();
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  // Claimed in one step, so one code can never give two tokens.
  const device = await RecorderDevice.findOneAndUpdate(
    { pairingCodeHash: hashOf(normalizeCode(code)), pairingExpiresAt: { $gt: now } },
    {
      $set: {
        tokenHash: hashOf(token),
        name: deviceName || 'Meeting recorder',
        connectedAt: now,
        lastUsedAt: now,
      },
      $unset: { pairingCodeHash: 1, pairingExpiresAt: 1 },
    },
    { returnDocument: 'after' },
  ).lean();
  if (!device) throw badRequest('This code is wrong or too old. Make a new code in the CRM.');
  const user = await loadRequestUser(device.userId);
  if (!user) {
    await RecorderDevice.deleteOne({ _id: device._id });
    throw badRequest('This code is wrong or too old. Make a new code in the CRM.');
  }
  await writeAudit({
    actor: user,
    action: 'recorder.connected',
    entityType: 'recorder_devices',
    entityId: device._id,
    newValue: { name: device.name },
    requestId: context.requestId,
  });
  return { token, user: { name: user.name, email: user.email } };
}

/**
 * Who sends this token: the user (as requireAuth gives it) and the recorder. Throws 401.
 * @param {string} token
 */
export async function loadRecorderByToken(token) {
  if (!String(token).startsWith(TOKEN_PREFIX)) throw unauthorized('Connect the recorder again');
  const device = await RecorderDevice.findOne({ tokenHash: hashOf(token) }).lean();
  const now = new Date();
  if (!device || !isUsable(device, now.getTime())) throw unauthorized('Connect the recorder again');
  const user = await loadRequestUser(device.userId);
  if (!user) throw unauthorized('Connect the recorder again');
  // Counted at most once an hour: the extension calls often during a meeting.
  if (now - device.lastUsedAt > DAY_MS / 24) {
    await RecorderDevice.updateOne({ _id: device._id }, { $set: { lastUsedAt: now } });
  }
  return { user, device: deviceView(device) };
}

/** Disconnect one of my recorders (or, from the extension, itself). */
export async function disconnectRecorder(actor, deviceId, context = {}) {
  const device = await RecorderDevice.findOneAndUpdate(
    { _id: deviceId, userId: actor._id, revokedAt: null, tokenHash: { $type: 'string' } },
    { $set: { revokedAt: new Date() }, $unset: { tokenHash: 1 } },
  ).lean();
  if (!device) throw notFound('Recorder not found');
  await writeAudit({
    actor,
    action: 'recorder.disconnected',
    entityType: 'recorder_devices',
    entityId: device._id,
    requestId: context.requestId,
  });
  return { disconnected: true };
}
