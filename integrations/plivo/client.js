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

let client = null;

/** The public address of this server: Plivo must be able to reach its webhooks from outside. */
const publicBase = () => env.API_PUBLIC_URL ?? env.REALTIME_URL ?? null;

export function isPlivoConfigured() {
  return Boolean(env.PLIVO_AUTH_ID && env.PLIVO_AUTH_TOKEN && env.PLIVO_NUMBER && publicBase());
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

// ── The answers to Plivo (XML) ──────────────────────────────────────────────────────────────

/**
 * "Dial this number and join it to the call."
 * @param {{ number: string, timeoutSec?: number, resultUrl: string,
 *           recordingUrl?: string, consentUrl?: string }} options
 *        resultUrl: called when the dialled side has ended (answered, busy, no answer)
 *        recordingUrl: set to record the conversation; Plivo sends the recording there
 *        consentUrl: a sound or speech played to the dialled side before the two are joined
 */
export function dialXml({ number, timeoutSec = 30, resultUrl, recordingUrl, consentUrl }) {
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
  dial.addNumber(toPlivoNumber(number));
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
