import { sendCreated, sendList, sendOk } from '../lib/respond.js';
import {
  addBundleMembers,
  createBundle,
  deleteBundle,
  findBundleCandidates,
  getBundle,
  listBundles,
  removeBundleMember,
  renameBundle,
} from '../services/bundles.service.js';

// Bundles: lists of people and companies for bulk sending. Each function: read the validated
// request, call one service function, respond.

// GET /api/bundles
export async function getBundles(req, res) {
  const { items, pagination } = await listBundles(req.user, req.validated.query);
  sendList(res, items, pagination);
}

// POST /api/bundles: empty, or from chosen companies and people.
export async function postBundle(req, res) {
  sendCreated(res, await createBundle(req.user, req.validated.body, { requestId: req.id }));
}

// GET /api/bundles/:id: the bundle and a page of who is in it.
export async function getBundleById(req, res) {
  const { params, query } = req.validated;
  const { bundle, members, pagination } = await getBundle(req.user, params.id, query);
  res.status(200).json({ data: { bundle, members }, meta: pagination });
}

// PATCH /api/bundles/:id: rename.
export async function patchBundle(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await renameBundle(req.user, params.id, body, { requestId: req.id }));
}

// DELETE /api/bundles/:id
export async function removeBundle(req, res) {
  sendOk(res, await deleteBundle(req.user, req.validated.params.id, { requestId: req.id }));
}

// POST /api/bundles/:id/members
export async function postMembers(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await addBundleMembers(req.user, params.id, body));
}

// DELETE /api/bundles/:id/members/:memberId
export async function removeMember(req, res) {
  const { id, memberId } = req.validated.params;
  sendOk(res, await removeBundleMember(req.user, id, memberId));
}

// GET /api/bundles/:id/candidates?search=…: who can still be added.
export async function getCandidates(req, res) {
  const { params, query } = req.validated;
  sendOk(res, await findBundleCandidates(req.user, params.id, query));
}
