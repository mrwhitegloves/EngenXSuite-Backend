import { getBranding } from '../services/settings.service.js';
import { sendOk } from '../lib/respond.js';

// GET /api/public/branding: the product name for the sign-in page.
// Public on purpose (the sign-in page needs it before anyone is signed in) and limited to
// values that are visible to anyone who opens the site anyway.
export async function getPublicBranding(req, res) {
  sendOk(res, await getBranding());
}
