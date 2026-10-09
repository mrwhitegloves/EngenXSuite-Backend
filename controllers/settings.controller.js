import { updateBranding } from '../services/settings.service.js';
import { sendOk } from '../lib/respond.js';

// PATCH /api/settings/branding: change the product name and/or the company name.
// (Reading them is public: GET /api/public/branding.)
export async function patchBranding(req, res) {
  sendOk(res, await updateBranding(req.user, req.validated.body, { requestId: req.id }));
}
