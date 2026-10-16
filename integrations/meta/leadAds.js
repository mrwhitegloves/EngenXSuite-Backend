import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { createAppError } from '../../lib/errors.js';

// The only file that talks to Meta about lead ads: checking that a webhook really comes from
// Meta, asking Meta for the answers of a lead, and the one-time connection of the Page (which
// Page the token belongs to, subscribing that Page's leads to our app, and its lead forms).
//
// A lead webhook carries only ids ("lead 123 was created on form 456"); the answers are fetched
// with the Page access token. Setup and troubleshooting: docs/META_LEADS.md.

const GRAPH_URL = 'https://graph.facebook.com';
const TIMEOUT_MS = 10_000;

/** True when the three settings Meta lead ads need are present. */
export function isMetaLeadsConfigured() {
  return Boolean(env.META_APP_SECRET && env.META_VERIFY_TOKEN && env.META_PAGE_ACCESS_TOKEN);
}

/** The answer to Meta's one-time "is this address yours?" request when the webhook is set up. */
export function isValidVerifyToken(token) {
  return Boolean(env.META_VERIFY_TOKEN) && token === env.META_VERIFY_TOKEN;
}

/**
 * Check the signature Meta puts on every webhook: an HMAC of the exact bytes of the body, made
 * with the app secret, in the header "X-Hub-Signature-256: sha256=<hex>".
 * @param {Buffer | undefined} rawBody
 * @param {string | undefined} header
 */
export function isValidMetaSignature(rawBody, header) {
  if (!env.META_APP_SECRET || !rawBody || !header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', env.META_APP_SECRET).update(rawBody).digest();
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  // Compared in constant time, so the check gives nothing away about the right value.
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function graphGet(path, fields, query = {}) {
  return graphRequest('GET', path, { fields, ...query });
}

async function graphRequest(method, path, params = {}) {
  if (!env.META_PAGE_ACCESS_TOKEN) {
    throw createAppError('META_NOT_CONFIGURED', 503, 'The Meta page access token is not set.');
  }
  const url = new URL(`${GRAPH_URL}/${env.META_GRAPH_VERSION}/${path}`);
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (method === 'GET') url.searchParams.set(key, String(value));
    else form.set(key, String(value));
  }
  let response;
  try {
    response = await fetch(url, {
      method,
      // The token goes in a header, never in the address (addresses end up in logs).
      headers: {
        Authorization: `Bearer ${env.META_PAGE_ACCESS_TOKEN}`,
        ...(method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
      },
      ...(method === 'GET' ? {} : { body: form.toString() }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw createAppError('META_UNREACHABLE', 502, 'Meta could not be reached.');
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    // Meta's own words say what is wrong (expired token, missing permission, unknown lead).
    const reason = body?.error?.message ?? `Meta answered ${response.status}`;
    throw createAppError('META_ERROR', 502, `Meta refused the request: ${reason}`);
  }
  return body;
}

/**
 * The answers of one lead, with the names of its campaign, ad set, ad and form.
 * @param {string} leadgenId
 * @returns {Promise<{ id: string, createdTime: Date | null, isTest: boolean, formId: string | null,
 *                     answers: { name: string, value: string }[], campaign: object }>}
 */
export async function fetchMetaLead(leadgenId) {
  const lead = await graphGet(
    encodeURIComponent(leadgenId),
    'id,created_time,field_data,form_id,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,is_organic,platform',
  );
  return {
    id: String(lead.id),
    createdTime: lead.created_time ? new Date(lead.created_time) : null,
    formId: lead.form_id ? String(lead.form_id) : null,
    // A question can have several values (a multiple choice): they are joined.
    answers: (lead.field_data ?? []).map((item) => ({
      name: String(item.name ?? ''),
      value: (item.values ?? []).map(String).join(', '),
    })),
    campaign: {
      campaignId: lead.campaign_id ?? null,
      campaignName: lead.campaign_name ?? null,
      adSetId: lead.adset_id ?? null,
      adSetName: lead.adset_name ?? null,
      adId: lead.ad_id ?? null,
      adName: lead.ad_name ?? null,
      platform: lead.platform ?? null,
    },
  };
}

/** The name of a lead form. null when Meta does not tell (the lead is still processed). */
export async function fetchMetaFormName(formId) {
  try {
    return (await graphGet(encodeURIComponent(formId), 'id,name')).name ?? null;
  } catch {
    return null;
  }
}

// ── The one-time connection of the Page ──────────────────────────────────────────────────────

/** The Page the token belongs to (a Page token answers "me" with the Page). */
export async function fetchMetaPage() {
  const page = await graphGet('me', 'id,name');
  return { id: String(page.id), name: page.name ?? null };
}

/**
 * The apps that receive this Page's webhooks, with their fields. Ours must have "leadgen".
 * @returns {Promise<{ id: string, name: string | null, fields: string[] }[]>}
 */
export async function fetchPageSubscriptions(pageId) {
  const body = await graphGet(
    `${encodeURIComponent(pageId)}/subscribed_apps`,
    'id,name,subscribed_fields',
  );
  return (body.data ?? []).map((app) => ({
    id: String(app.id),
    name: app.name ?? null,
    fields: (app.subscribed_fields ?? []).map(String),
  }));
}

/** Tell Meta to send this Page's new leads to our app (the app of the token). */
export async function subscribePageToLeads(pageId) {
  const body = await graphRequest('POST', `${encodeURIComponent(pageId)}/subscribed_apps`, {
    subscribed_fields: 'leadgen',
  });
  return body?.success === true;
}

/**
 * The lead forms of the Page, with the names of their questions.
 * @returns {Promise<{ id: string, name: string, status: string | null, questions: string[] }[]>}
 */
export async function fetchPageForms(pageId) {
  const body = await graphGet(
    `${encodeURIComponent(pageId)}/leadgen_forms`,
    'id,name,status,questions',
    {
      limit: 100,
    },
  );
  return (body.data ?? []).map((form) => ({
    id: String(form.id),
    name: String(form.name ?? `Form ${form.id}`).slice(0, 200),
    status: form.status ?? null,
    questions: (form.questions ?? []).map((question) => String(question.key ?? '')).filter(Boolean),
  }));
}
