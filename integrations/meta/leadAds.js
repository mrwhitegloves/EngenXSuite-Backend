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

async function graphGet(path, fields, query = {}, token) {
  return graphRequest('GET', path, { fields, ...query }, token);
}

/**
 * @param {string} [token]  Another token than the one in the settings (the Page's own token,
 *                          found through a user or system user token; see resolvePage)
 */
async function graphRequest(method, path, params = {}, token = env.META_PAGE_ACCESS_TOKEN) {
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
        Authorization: `Bearer ${token}`,
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
  const fields =
    'id,created_time,field_data,form_id,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,is_organic,platform';
  const lead = await withPageTokenWhenRefused((token) =>
    graphGet(encodeURIComponent(leadgenId), fields, {}, token),
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
    const form = await withPageTokenWhenRefused((token) =>
      graphGet(encodeURIComponent(formId), 'id,name', {}, token),
    );
    return form.name ?? null;
  } catch {
    return null;
  }
}

// ── The one-time connection of the Page ──────────────────────────────────────────────────────

/**
 * The Page, and a token that may act for it. The setting may hold either:
 *   - a Page access token: "me" is the Page itself; or
 *   - a user or system user token (what Meta's Business settings give most easily): "me" is a
 *     person, whose Pages (with each Page's own token) are listed by "me/accounts". With several
 *     Pages, META_PAGE_ID says which one.
 * Page-only calls (its subscribed apps, its lead forms) need the Page's own token. Nothing of a
 * token is ever logged or answered.
 * @returns {Promise<{ id: string, name: string | null, token: string }>}
 */
async function resolvePage() {
  let pages = null;
  try {
    pages = (await graphGet('me/accounts', 'id,name,access_token', { limit: 100 })).data ?? [];
  } catch (error) {
    // A Page token has no "accounts": it is the Page itself.
    if (!/accounts/i.test(error?.message ?? '')) throw error;
  }
  if (pages === null) {
    const page = await graphGet('me', 'id,name');
    return { id: String(page.id), name: page.name ?? null, token: env.META_PAGE_ACCESS_TOKEN };
  }
  const usable = pages.filter((page) => page.access_token);
  const chosen = env.META_PAGE_ID
    ? usable.find((page) => String(page.id) === String(env.META_PAGE_ID))
    : usable.length === 1
      ? usable[0]
      : null;
  if (!chosen) {
    const names = usable.map((page) => `${page.name} (${page.id})`).join(', ');
    throw createAppError(
      'META_PAGE_UNKNOWN',
      409,
      usable.length === 0
        ? 'The token is a person’s token and sees no Facebook Page. In Meta Business settings → Users → System users → Assign assets, give it the Page (with leads and Page settings allowed), then make the token again with the permissions pages_show_list, pages_manage_metadata and leads_retrieval.'
        : env.META_PAGE_ID
          ? `The token does not see the Page META_PAGE_ID names. It sees: ${names}.`
          : `The token sees several Pages: ${names}. Put the id of the right one in META_PAGE_ID.`,
    );
  }
  return { id: String(chosen.id), name: chosen.name ?? null, token: String(chosen.access_token) };
}

/** Try with the token of the settings; when Meta refuses it, once more with the Page's own. */
async function withPageTokenWhenRefused(request) {
  try {
    return await request(env.META_PAGE_ACCESS_TOKEN);
  } catch (error) {
    if (error?.code !== 'META_ERROR') throw error;
    let page;
    try {
      page = await resolvePage();
    } catch {
      throw error;
    }
    if (page.token === env.META_PAGE_ACCESS_TOKEN) throw error;
    return request(page.token);
  }
}

/** The Page the CRM works with (see resolvePage). */
export async function fetchMetaPage() {
  const { id, name } = await resolvePage();
  return { id, name };
}

/**
 * The apps that receive this Page's webhooks, with their fields. Ours must have "leadgen".
 * @returns {Promise<{ id: string, name: string | null, fields: string[] }[]>}
 */
export async function fetchPageSubscriptions(pageId) {
  const { token } = await resolvePage();
  const body = await graphGet(
    `${encodeURIComponent(pageId)}/subscribed_apps`,
    'id,name,subscribed_fields',
    {},
    token,
  );
  return (body.data ?? []).map((app) => ({
    id: String(app.id),
    name: app.name ?? null,
    fields: (app.subscribed_fields ?? []).map(String),
  }));
}

/** Tell Meta to send this Page's new leads to our app (the app of the token). */
export async function subscribePageToLeads(pageId) {
  const { token } = await resolvePage();
  const body = await graphRequest(
    'POST',
    `${encodeURIComponent(pageId)}/subscribed_apps`,
    { subscribed_fields: 'leadgen' },
    token,
  );
  return body?.success === true;
}

/**
 * The lead forms of the Page, with the names of their questions.
 * @returns {Promise<{ id: string, name: string, status: string | null, questions: string[] }[]>}
 */
export async function fetchPageForms(pageId) {
  const { token } = await resolvePage();
  const body = await graphGet(
    `${encodeURIComponent(pageId)}/leadgen_forms`,
    'id,name,status,questions',
    {
      limit: 100,
    },
    token,
  );
  return (body.data ?? []).map((form) => ({
    id: String(form.id),
    name: String(form.name ?? `Form ${form.id}`).slice(0, 200),
    status: form.status ?? null,
    questions: (form.questions ?? []).map((question) => String(question.key ?? '')).filter(Boolean),
  }));
}
