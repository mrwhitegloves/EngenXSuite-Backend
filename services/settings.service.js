import { Settings } from '../models/settings.model.js';
import { env } from '../config/env.js';
import { CACHE_TTL } from '../config/cacheTtl.js';
import { getOrSet } from '../infra/cache.js';

export const BRANDING_CACHE_KEY = 'branding';

/**
 * The product and company names shown everywhere (decision 0001).
 * Read from the settings record; the environment values are only the fallback for a database
 * that has not been seeded yet. This is the ONE function other code uses to get the names.
 * @returns {Promise<{ productName: string, companyName: string }>}
 */
export function getBranding() {
  // Asked for on every page load and almost never changed, so it is cached for a few minutes.
  // Whatever edits the branding must call invalidate(BRANDING_CACHE_KEY) in the same function.
  return getOrSet(BRANDING_CACHE_KEY, CACHE_TTL.branding, async () => {
    const settings = await Settings.findOne({ key: 'app' }).select('branding').lean();
    return {
      productName: settings?.branding?.productName ?? env.APP_NAME,
      companyName: settings?.branding?.companyName ?? env.COMPANY_NAME,
    };
  });
}
