import { getBranding } from '../services/settings.service.js';
import { env } from '../config/env.js';
import { sendOk } from '../lib/respond.js';

// GET /api/public/branding: the product name for the sign-in page.
// Public on purpose (the sign-in page needs it before anyone is signed in) and limited to
// values that are visible to anyone who opens the site anyway.
export async function getPublicBranding(req, res) {
  sendOk(res, await getBranding());
}

// GET /api/public/config: what the browser app needs before anyone signs in.
// The Sentry DSN of the browser project is public by design (it only allows sending errors).
export async function getPublicConfig(req, res) {
  sendOk(res, {
    branding: await getBranding(),
    sentryDsn: env.SENTRY_CLIENT ?? null,
    environment: env.NODE_ENV,
  });
}
