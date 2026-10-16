import { randomBytes } from 'node:crypto';
import plivo from 'plivo';
import { env } from '../../config/env.js';
import { createAppError } from '../../lib/errors.js';

// The only file that talks to Plivo (phone calls): starting a call, checking that a webhook
// really comes from Plivo, and writing the small XML answers that tell Plivo what to do with
// a call. Setup and troubleshooting: docs/PLIVO.md.
//
// The call flow is the one proven in the prototype (plivo-testing-code/):
//   click-to-call : Plivo rings the agent's own phone; when they pick up, Plivo asks us what
//                   to do ("connect") and we answer "dial the customer".
//   inbound       : a customer calls our Plivo number; Plivo asks us ("inbound") and we answer
//                   "dial the phone of the person who looks after this customer".
//   browser       : calls inside the CRM (docs/planning/browser-calling.md). Each person's
//                   browser is a Plivo endpoint attached to the Application of our number, and
//                   signs in with a short access token that only this server can get. A call
//                   the browser starts reaches the same "inbound" address, from sip:<endpoint>.

let client = null;

/** The public address of this server: Plivo must be able to reach its webhooks from outside. */
const publicBase = () => env.API_PUBLIC_URL ?? env.REALTIME_URL ?? null;

export function isPlivoConfigured() {
  return Boolean(env.PLIVO_AUTH_ID && env.PLIVO_AUTH_TOKEN && env.PLIVO_NUMBER && publicBase());
}

/** Calls inside the CRM need the Application of our number as well. */
export function isBrowserCallingConfigured() {
  return isPlivoConfigured() && Boolean(env.PLIVO_APP_ID);
}

/** The names of the settings that are still missing (names only, for the settings screen). */
export function missingPlivoSettings() {
  return [
    !env.PLIVO_AUTH_ID && 'PLIVO_AUTH_ID',
    !env.PLIVO_AUTH_TOKEN && 'PLIVO_AUTH_TOKEN',
    !env.PLIVO_NUMBER && 'PLIVO_NUMBER',
    !publicBase() && 'API_PUBLIC_URL',
  ].filter(Boolean);
}

/** The full address of one of our Plivo webhooks, for example plivoUrl('hangup', { call: id }). */
export function plivoUrl(name, query = {}) {
  const url = new URL(`/api/webhooks/plivo/${name}`, publicBase());
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  return url.toString();
}

/** Plivo wants numbers as digits only: "+919876543210" → "919876543210". */
export const toPlivoNumber = (phone) => String(phone ?? '').replace(/\D/g, '');
/** Our Plivo number in the international form, for showing and storing. */
export const ourNumber = () => `+${toPlivoNumber(env.PLIVO_NUMBER)}`;

function getClient() {
  if (!isPlivoConfigured()) {
    throw createAppError('PLIVO_NOT_CONFIGURED', 503, 'Calling is not set up yet.');
  }
  // plivo.Client is the library's class; it is created once, here.
  if (!client) client = new plivo.Client(env.PLIVO_AUTH_ID, env.PLIVO_AUTH_TOKEN);
  return client;
}

/**
 * Start a call from our Plivo number to one phone (the agent's). When that phone picks up,
 * Plivo calls `answerUrl`; when the call ends, `hangupUrl`.
 * @returns {Promise<{ requestUuid: string }>} Plivo's id for the call it is about to make
 */
export async function startCall({ to, answerUrl, hangupUrl }) {
  try {
    const response = await getClient().calls.create(
      toPlivoNumber(env.PLIVO_NUMBER),
      toPlivoNumber(to),
      answerUrl,
      { answerMethod: 'POST', hangupUrl, hangupMethod: 'POST' },
    );
    const uuid = Array.isArray(response.requestUuid)
      ? response.requestUuid[0]
      : response.requestUuid;
    return { requestUuid: String(uuid) };
  } catch (error) {
    if (error?.isAppError) throw error;
    // Plivo's own words say what is wrong (no credit, number not allowed, wrong token).
    const reason = error?.message ? String(error.message).slice(0, 200) : 'unknown reason';
    throw createAppError('PLIVO_ERROR', 502, `Plivo could not start the call: ${reason}`);
  }
}

/**
 * What Plivo's own books say about one finished leg of a call: how long it lasted and what it
 * cost. This is what the Plivo console shows, and it is ready a short while after the hang-up.
 * @param {string} uuid  The leg's call UUID
 * @returns {Promise<{ durationSec: number, cost: number, hangupCause: string | null } | null>}
 *          null when Plivo has no record of it (yet)
 */
export async function getCallRecord(uuid) {
  try {
    const record = await getClient().calls.get(uuid);
    const pick = (camel, snake) => record?.[camel] ?? record?.[snake];
    return {
      // The real length. (The billed length is rounded up to Plivo's 30-second steps.)
      durationSec:
        Number(pick('callDuration', 'call_duration') ?? pick('billDuration', 'bill_duration')) || 0,
      cost: Number(pick('totalAmount', 'total_amount')) || 0,
      hangupCause: pick('hangupCauseName', 'hangup_cause_name') ?? null,
    };
  } catch (error) {
    if (error?.isAppError) throw error;
    if (error?.status === 404 || /not found/i.test(String(error?.message))) return null;
    const reason = error?.message ? String(error.message).slice(0, 200) : 'unknown reason';
    throw createAppError('PLIVO_ERROR', 502, `Plivo did not give the call record: ${reason}`);
  }
}

/**
 * Check Plivo's signature on a webhook (signature version 3: an HMAC over the full address,
 * the form fields and a one-time value, made with the auth token).
 * @param {import('express').Request} req
 */
export function isValidPlivoSignature(req) {
  const signature = req.get('x-plivo-signature-v3');
  const nonce = req.get('x-plivo-signature-v3-nonce');
  if (!env.PLIVO_AUTH_TOKEN || !publicBase() || !signature || !nonce) return false;
  // The address exactly as Plivo called it: our public address plus the path and query.
  const url = new URL(req.originalUrl, publicBase()).toString();
  const params = req.method === 'GET' ? {} : (req.body ?? {});
  return plivo.validateV3Signature(req.method, url, nonce, env.PLIVO_AUTH_TOKEN, signature, params);
}

// ── Browsers (calls inside the CRM) ───────────────────────────────────────────────────────

/** The SIP address of a browser endpoint. */
export const endpointSipUri = (username) => `sip:${username}@phone.plivo.com`;

/** The endpoint's username when a call comes FROM a browser ("sip:crm12…@phone.plivo.com"). */
export function endpointOfCaller(from) {
  const match = /^sip:([a-z][a-z0-9]{0,63})@/i.exec(String(from ?? '').trim());
  return match ? match[1] : null;
}

/**
 * Make a browser endpoint for one person, attached to our Application. Plivo adds digits to the
 * username. The password is never used (the browser signs in with an access token), so it is
 * random and not kept.
 * @returns {Promise<{ id: string, username: string }>}
 */
export async function createEndpoint({ name, alias }) {
  const password = randomBytes(18).toString('base64url');
  try {
    const created = await getClient().endpoints.create(name, password, alias, env.PLIVO_APP_ID);
    return { id: String(created.endpointId ?? created.id), username: String(created.username) };
  } catch (error) {
    const reason = String(error?.message ?? 'unknown error').slice(0, 200);
    throw createAppError(
      'PLIVO_ERROR',
      502,
      `Plivo could not set up calling in the browser: ${reason}`,
    );
  }
}

/**
 * A short access token with which ONE endpoint signs in from the browser. Made by Plivo (it
 * refuses tokens we sign ourselves). At most 24 hours (Plivo's limit).
 * @returns {Promise<{ token: string, expiresAt: Date }>}
 */
export async function createAccessToken({ username, validSec }) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + Math.min(validSec, 24 * 60 * 60 - 60);
  try {
    const response = await getClient().token.create(env.PLIVO_AUTH_ID, {
      sub: username,
      nbf: now - 30,
      exp,
      incoming_allow: true,
      outgoing_allow: true,
      app: env.PLIVO_APP_ID,
    });
    return { token: String(response.token), expiresAt: new Date(exp * 1000) };
  } catch (error) {
    const reason = String(error?.message ?? 'unknown error').slice(0, 200);
    throw createAppError(
      'PLIVO_ERROR',
      502,
      `Plivo did not give a sign-in for the browser: ${reason}`,
    );
  }
}

// ── The answers to Plivo (XML) ──────────────────────────────────────────────────────────────

/**
 * "Dial this number (and/or these browsers) and join it to the call." Several ring at the
 * same time; the first to answer is joined.
 * @param {{ number?: string, browsers?: { username: string, callId?: string }[],
 *           timeoutSec?: number, resultUrl: string, recordingUrl?: string,
 *           consentUrl?: string }} options
 *        browsers: endpoints to ring as well; callId reaches the browser as the header
 *                  X-PH-CallId, so it can show who is calling
 *        resultUrl: called when the dialled side has ended (answered, busy, no answer)
 *        recordingUrl: set to record the conversation; Plivo sends the recording there
 *        consentUrl: a sound or speech played to the dialled side before the two are joined
 */
export function dialXml({
  number,
  browsers = [],
  timeoutSec = 30,
  resultUrl,
  recordingUrl,
  consentUrl,
}) {
  const response = new plivo.Response();
  if (recordingUrl) {
    response.addRecord({
      action: recordingUrl,
      method: 'POST',
      // Recording starts when the dialled side picks up, and does not end the call flow.
      startOnDialAnswer: 'true',
      redirect: 'false',
      maxLength: '7200',
    });
  }
  const dial = response.addDial({
    callerId: toPlivoNumber(env.PLIVO_NUMBER),
    timeout: String(timeoutSec),
    action: resultUrl,
    method: 'POST',
    ...(consentUrl ? { confirmSound: consentUrl } : {}),
  });
  for (const browser of browsers) {
    dial.addUser(
      endpointSipUri(browser.username),
      browser.callId ? { sipHeaders: `CallId=${browser.callId}` } : {},
    );
  }
  if (number) dial.addNumber(toPlivoNumber(number));
  return response.toXML();
}

/** "Say this to the caller, then hang up." */
export function speakXml(text) {
  const response = new plivo.Response();
  response.addSpeak(text);
  return response.toXML();
}

/** "Nothing more to do." */
export function emptyXml() {
  return new plivo.Response().toXML();
}

/**
 * Fetch a finished recording from Plivo.
 * @returns {Promise<{ body: Buffer, contentType: string }>}
 */
export async function downloadRecording(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    throw createAppError(
      'PLIVO_ERROR',
      502,
      `The recording could not be fetched (${response.status}).`,
    );
  }
  return {
    body: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') ?? 'audio/mpeg',
  };
}
