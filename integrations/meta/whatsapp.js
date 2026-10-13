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

async function post(path, body) {
  if (!isWhatsAppConfigured()) {
    throw createAppError('WHATSAPP_NOT_CONFIGURED', 503, 'WhatsApp is not set up yet.');
  }
  let response;
  try {
    response = await fetch(`${GRAPH_URL}/${env.META_GRAPH_VERSION}/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
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

/**
 * Send a plain text message. Works only inside the 24 hours after the customer's last message.
 * @param {string} to  The customer's number, digits only with the country code ("919876543210")
 * @returns {Promise<{ wamid: string }>}  Meta's id of the message
 */
export async function sendWhatsAppText(to, text) {
  const answer = await post(`${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: false, body: text },
  });
  return { wamid: String(answer.messages?.[0]?.id ?? '') };
}
