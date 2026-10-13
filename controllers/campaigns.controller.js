import { sendCreated, sendList, sendOk } from '../lib/respond.js';
import {
  addOptOut,
  getStopPage,
  listOptOuts,
  removeOptOut,
  stopByLink,
} from '../services/bulkOptOuts.service.js';
import {
  bundleFromUnsent,
  createCampaign,
  getCampaign,
  listCampaigns,
  listRecipients,
  previewCampaign,
  startCampaign,
  stopCampaign,
} from '../services/campaigns.service.js';

// Bulk sending. Each function: read the validated request, call one service function, respond.

// GET /api/campaigns
export async function getCampaigns(req, res) {
  const { items, pagination } = await listCampaigns(req.user, req.validated.query);
  sendList(res, items, pagination);
}

// POST /api/campaigns: make a sending from a bundle (a draft: nothing goes out yet).
export async function postCampaign(req, res) {
  sendCreated(res, await createCampaign(req.user, req.validated.body, { requestId: req.id }));
}

// GET /api/campaigns/:id
export async function getCampaignById(req, res) {
  sendOk(res, await getCampaign(req.user, req.validated.params.id));
}

// GET /api/campaigns/:id/recipients: who got what, when, and why not.
export async function getRecipients(req, res) {
  const { params, query } = req.validated;
  const { items, pagination } = await listRecipients(req.user, params.id, query);
  sendList(res, items, pagination);
}

// POST /api/campaigns/:id/preview: what it would do, and one mail as the AI would write it.
export async function postPreview(req, res) {
  sendOk(res, await previewCampaign(req.user, req.validated.params.id));
}

// POST /api/campaigns/:id/start: start a draft or let a paused sending go on; with "at",
// plan it for that moment.
export async function postStart(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await startCampaign(req.user, params.id, { requestId: req.id }, body));
}

// GET /api/campaigns/opt-outs: the addresses and numbers that get no bulk messages.
export async function getOptOuts(req, res) {
  const { items, pagination } = await listOptOuts(req.validated.query);
  sendList(res, items, pagination);
}

// POST /api/campaigns/opt-outs
export async function postOptOut(req, res) {
  sendCreated(res, await addOptOut(req.user, req.validated.body, { requestId: req.id }));
}

// DELETE /api/campaigns/opt-outs/:id
export async function deleteOptOut(req, res) {
  await removeOptOut(req.user, req.validated.params.id, { requestId: req.id });
  sendOk(res, { removed: true });
}

// GET /api/public/stop-mail/:token: the page behind the link in a bulk mail. No sign-in.
export async function getPublicStopPage(req, res) {
  sendOk(res, await getStopPage(req.validated.params.token));
}

// POST /api/public/stop-mail/:token: the customer stops bulk mails to their address.
export async function postPublicStop(req, res) {
  sendOk(res, await stopByLink(req.validated.params.token));
}

// POST /api/campaigns/:id/stop: pause or cancel.
export async function postStop(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await stopCampaign(req.user, params.id, body, { requestId: req.id }));
}

// POST /api/campaigns/:id/bundle: the people who did not get it, as a new bundle.
export async function postBundleFromUnsent(req, res) {
  const { params, body } = req.validated;
  sendCreated(res, await bundleFromUnsent(req.user, params.id, body, { requestId: req.id }));
}
