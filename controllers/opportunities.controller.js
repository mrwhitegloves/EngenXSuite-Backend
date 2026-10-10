import {
  changeLeadStage,
  createLead,
  deleteLead,
  getLead,
  getLeadFormOptions,
  listLeads,
  updateLead,
} from '../services/opportunities.service.js';
import { sendCreated, sendList, sendOk } from '../lib/respond.js';

// Leads. Each function: read the validated request, call one service function, respond.

const context = (req) => ({ requestId: req.id });

// GET /api/opportunities
export async function getLeads(req, res) {
  const { items, pagination } = await listLeads(req.user, req.validated.query);
  sendList(res, items, pagination);
}

// GET /api/opportunities/form-options: the lists the lead form and the filters offer.
export async function getFormOptions(req, res) {
  sendOk(res, await getLeadFormOptions(req.user));
}

// POST /api/opportunities
export async function postLead(req, res) {
  sendCreated(res, await createLead(req.user, req.validated.body, context(req)));
}

// GET /api/opportunities/:id
export async function getLeadById(req, res) {
  sendOk(res, await getLead(req.user, req.validated.params.id));
}

// PATCH /api/opportunities/:id
export async function patchLead(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await updateLead(req.user, params.id, body, context(req)));
}

// POST /api/opportunities/:id/stage: move the lead to another stage.
export async function postStage(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await changeLeadStage(req.user, params.id, body, context(req)));
}

// DELETE /api/opportunities/:id
export async function removeLead(req, res) {
  await deleteLead(req.user, req.validated.params.id, context(req));
  sendOk(res, { deleted: true });
}
