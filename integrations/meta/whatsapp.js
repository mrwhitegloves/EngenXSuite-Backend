import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { createAppError } from '../../lib/errors.js';

// The only file that talks to the WhatsApp Cloud API (Meta). What is sent, to whom and when is
// decided by services/whatsapp.service.js.

const GRAPH_URL = 'https://graph.facebook.com';
// The secret of the Meta app that owns the WhatsApp number; the same app as the lead ads
// unless WHATSAPP_APP_SECRET says otherwise.
const appSecret = () => env.WHATSAPP_APP_SECRET ?? env.META_APP_SECRET;

/** The settings without which WhatsApp cannot work (names only). */
export function missingWhatsAppSettings() {
  return [
    ['WHATSAPP_PHONE_NUMBER_ID', env.WHATSAPP_PHONE_NUMBER_ID],
    ['WHATSAPP_ACCESS_TOKEN', env.WHATSAPP_ACCESS_TOKEN],
    ['WHATSAPP_VERIFY_TOKEN', env.WHATSAPP_VERIFY_TOKEN],
    ['WHATSAPP_APP_SECRET', appSecret()],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
}
export const isWhatsAppConfigured = () => missingWhatsAppSettings().length === 0;

/** The check Meta asks for once, when the webhook address is typed into its console. */
export function isValidWhatsAppVerifyToken(token) {
  if (!env.WHATSAPP_VERIFY_TOKEN || typeof token !== 'string') return false;
  const given = Buffer.from(token);
  const ours = Buffer.from(env.WHATSAPP_VERIFY_TOKEN);
  return given.length === ours.length && timingSafeEqual(given, ours);
}

/** True only when the webhook body was signed with our app's secret. */
export function isValidWhatsAppSignature(rawBody, header) {
  const secret = appSecret();
  if (!secret || !rawBody || !header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  // Compared in constant time, so the check gives nothing away about the right value.
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// The largest file we fetch from Meta (its own limit for documents is 100 MB; ours is lower).
const MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024;

function assertConfigured() {
  if (!isWhatsAppConfigured()) {
    throw createAppError('WHATSAPP_NOT_CONFIGURED', 503, 'WhatsApp is not set up yet.');
  }
}

/** One call to the Graph API. `body` is JSON, or FormData for a file upload. */
async function call(method, path, body, timeoutMs = 20_000) {
  assertConfigured();
  const isForm = body instanceof FormData;
  let response;
  try {
    response = await fetch(`${GRAPH_URL}/${env.META_GRAPH_VERSION}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
        ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw createAppError('WHATSAPP_UNREACHABLE', 502, 'WhatsApp could not be reached. Try again.');
  }
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = createAppError(
      'WHATSAPP_ERROR',
      502,
      `WhatsApp refused the message: ${String(answer?.error?.message ?? response.status).slice(0, 200)}`,
    );
    // Meta's own number for the reason (131047: the 24-hour window is closed, …).
    error.providerCode = answer?.error?.code ? String(answer.error.code) : undefined;
    throw error;
  }
  return answer;
}

/** Send one message of any kind; `replyTo` is Meta's id of the message it answers. */
async function sendMessage(to, content, replyTo) {
  const answer = await call('POST', `${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    ...(replyTo ? { context: { message_id: replyTo } } : {}),
    ...content,
  });
  return { wamid: String(answer.messages?.[0]?.id ?? '') };
}

/**
 * Send a plain text message. Works only inside the 24 hours after the customer's last message.
 * @param {string} to  The customer's number, digits only with the country code ("919876543210")
 * @returns {Promise<{ wamid: string }>}  Meta's id of the message
 */
export function sendWhatsAppText(to, text, replyTo) {
  return sendMessage(to, { type: 'text', text: { preview_url: false, body: text } }, replyTo);
}

/**
 * Put a file into Meta's media store, so it can be sent by its id (no public link needed).
 * @param {{ buffer: Buffer, mimeType: string, fileName: string }} file
 * @returns {Promise<string>}  Meta's media id
 */
export async function uploadWhatsAppMedia({ buffer, mimeType, fileName }) {
  assertConfigured();
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', new Blob([buffer], { type: mimeType }), fileName);
  const answer = await call('POST', `${env.WHATSAPP_PHONE_NUMBER_ID}/media`, form, 60_000);
  return String(answer.id ?? '');
}

/**
 * Send a file that is in Meta's media store.
 * @param {string} to  Digits only with the country code
 * @param {{ kind: 'image' | 'video' | 'audio' | 'document' | 'sticker', mediaId: string,
 *           caption?: string, fileName?: string }} file
 * @param {string} [replyTo]  Meta's id of the message it answers
 */
export function sendWhatsAppMedia(to, { kind, mediaId, caption, fileName }, replyTo) {
  const body = { id: mediaId };
  // WhatsApp shows no caption under a voice message or a sticker.
  if (caption && !['audio', 'sticker'].includes(kind)) body.caption = caption;
  if (kind === 'document' && fileName) body.filename = fileName;
  return sendMessage(to, { type: kind, [kind]: body }, replyTo);
}

/**
 * A file a customer sent: its details, then its bytes (fetched with our token).
 * @returns {Promise<{ buffer: Buffer, mimeType: string, size: number }>}
 */
export async function downloadWhatsAppMedia(mediaId) {
  const info = await call('GET', encodeURIComponent(mediaId));
  if (Number(info.file_size ?? 0) > MAX_DOWNLOAD_BYTES) {
    throw createAppError('WHATSAPP_FILE_TOO_LARGE', 413, 'The file is larger than 30 MB.');
  }
  let response;
  try {
    response = await fetch(info.url, {
      headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw createAppError('WHATSAPP_UNREACHABLE', 502, 'WhatsApp could not be reached. Try again.');
  }
  if (!response.ok) {
    throw createAppError(
      'WHATSAPP_ERROR',
      502,
      `The file could not be fetched (${response.status}).`,
    );
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_DOWNLOAD_BYTES) {
    throw createAppError('WHATSAPP_FILE_TOO_LARGE', 413, 'The file is larger than 30 MB.');
  }
  return {
    buffer,
    mimeType: String(info.mime_type ?? 'application/octet-stream'),
    size: buffer.length,
  };
}

/**
 * Every template of the WhatsApp Business Account as Meta describes it (all statuses).
 * Empty when WHATSAPP_BUSINESS_ACCOUNT_ID is not set.
 */
export async function fetchWhatsAppTemplates() {
  if (!env.WHATSAPP_BUSINESS_ACCOUNT_ID) return [];
  const templates = [];
  const fields = 'name,language,status,category,components';
  let after = null;
  // At most 5 pages (500 templates): far more than a company keeps.
  for (let page = 0; page < 5; page += 1) {
    const answer = await call(
      'GET',
      `${encodeURIComponent(env.WHATSAPP_BUSINESS_ACCOUNT_ID)}/message_templates?fields=${fields}&limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`,
    );
    templates.push(...(answer.data ?? []));
    after = answer.paging?.next ? answer.paging?.cursors?.after : null;
    if (!after) break;
  }
  return templates;
}

/** The business number as Meta shows it: the number, the name and the quality rating. */
export async function fetchWhatsAppNumber() {
  const answer = await call(
    'GET',
    `${encodeURIComponent(env.WHATSAPP_PHONE_NUMBER_ID)}?fields=display_phone_number,verified_name,quality_rating`,
  );
  return {
    displayNumber: answer.display_phone_number ?? null,
    verifiedName: answer.verified_name ?? null,
    qualityRating: answer.quality_rating ?? null,
  };
}

/**
 * Send an approved template message. The only kind of message WhatsApp lets us START a
 * conversation with, or send after the 24-hour window.
 * @param {string} to  Digits only with the country code
 * @param {{ name: string, language: string, params?: (string | { name: string, text: string })[],
 *           header?: { kind: 'image' | 'video' | 'document', mediaId: string, fileName?: string } }} template
 *        params: the texts for the {{1}}, {{2}} … places of the template's body, in order
 *        header: the file of a template whose header is a picture, a video or a document
 * @returns {Promise<{ wamid: string }>}
 */
export function sendWhatsAppTemplate(to, { name, language, params = [], header }) {
  const components = [];
  if (header) {
    const media = { id: header.mediaId };
    if (header.kind === 'document' && header.fileName) media.filename = header.fileName;
    components.push({ type: 'header', parameters: [{ type: header.kind, [header.kind]: media }] });
  }
  if (params.length) {
    // A template with named variables ({{first_name}}) gets each value with its name.
    components.push({
      type: 'body',
      parameters: params.map((param) =>
        typeof param === 'string'
          ? { type: 'text', text: param }
          : { type: 'text', parameter_name: param.name, text: param.text },
      ),
    });
  }
  return sendMessage(to, {
    type: 'template',
    template: { name, language: { code: language }, ...(components.length ? { components } : {}) },
  });
}
