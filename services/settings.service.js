import { Settings } from '../models/settings.model.js';
import { env } from '../config/env.js';

/**
 * The product and company names shown everywhere (decision 0001).
 * Read from the settings record; the environment values are only the fallback for a database
 * that has not been seeded yet. This is the ONE function other code uses to get the names.
 * @returns {Promise<{ productName: string, companyName: string }>}
 */
export async function getBranding() {
  const settings = await Settings.findOne({ key: 'app' }).select('branding').lean();
  return {
    productName: settings?.branding?.productName ?? env.APP_NAME,
    companyName: settings?.branding?.companyName ?? env.COMPANY_NAME,
  };
}
