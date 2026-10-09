import { Settings } from '../models/settings.model.js';
import { env } from '../config/env.js';
import { CACHE_TTL } from '../config/cacheTtl.js';
import { SOCKET_EVENTS } from '../constants/socketEvents.js';
import { getOrSet, invalidate } from '../infra/cache.js';
import { emitToAll } from '../infra/realtime.js';
import { diffFields, writeAudit } from '../lib/audit.js';

export const BRANDING_CACHE_KEY = 'branding';

async function readBranding() {
  const settings = await Settings.findOne({ key: 'app' }).select('branding').lean();
  return {
    productName: settings?.branding?.productName ?? env.APP_NAME,
    companyName: settings?.branding?.companyName ?? env.COMPANY_NAME,
  };
}

/**
 * The product and company names shown everywhere (decision 0001).
 * Read from the settings record; the environment values are only the fallback for a database
 * that has not been seeded yet. This is the ONE function other code uses to get the names.
 * @returns {Promise<{ productName: string, companyName: string }>}
 */
export function getBranding() {
  // Asked for on every page load and almost never changed, so it is cached for a few minutes.
  return getOrSet(BRANDING_CACHE_KEY, CACHE_TTL.branding, readBranding);
}

/**
 * Change the product name and/or the company name. The new names show everywhere at once:
 * the cached copy is dropped and every open browser is told to reload them.
 * @param {object} actor
 * @param {{ productName?: string, companyName?: string }} changes  Already validated
 * @param {{ requestId?: string }} [context]
 */
export async function updateBranding(actor, changes, context = {}) {
  const before = await readBranding();
  const { oldValue, newValue, changed } = diffFields(before, changes);
  if (!changed) return before;

  const after = { ...before, ...newValue };
  const settings = await Settings.findOneAndUpdate(
    { key: 'app' },
    {
      $set: {
        'branding.productName': after.productName,
        'branding.companyName': after.companyName,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  await invalidate(BRANDING_CACHE_KEY);
  await writeAudit({
    actor,
    action: 'settings.branding_updated',
    entityType: 'settings',
    entityId: settings._id,
    oldValue,
    newValue,
    requestId: context.requestId,
  });
  emitToAll(SOCKET_EVENTS.brandingChanged);
  return after;
}
