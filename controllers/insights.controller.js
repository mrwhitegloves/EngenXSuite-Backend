import { sendOk } from '../lib/respond.js';
import { getAiSettingsView, updateAiSettings } from '../services/aiSettings.service.js';
import {
  getAccountSummary,
  getLeadAssessment,
  refreshAccountSummary,
  refreshLeadAssessment,
} from '../services/insights.service.js';

// AI insights and the AI settings.
// Each function: read the validated request, call one service function, respond.

// GET /api/insights/accounts/:id: the saved AI summary of a company.
export async function getAccountInsight(req, res) {
  sendOk(res, await getAccountSummary(req.user, req.validated.params.id));
}

// POST /api/insights/accounts/:id/refresh: ask the AI for a new summary.
export async function postAccountInsight(req, res) {
  sendOk(res, await refreshAccountSummary(req.user, req.validated.params.id));
}

// GET /api/insights/leads/:id: the saved score and next best action of a lead.
export async function getLeadInsight(req, res) {
  sendOk(res, await getLeadAssessment(req.user, req.validated.params.id));
}

// POST /api/insights/leads/:id/refresh: ask the AI to assess the lead again.
export async function postLeadInsight(req, res) {
  sendOk(res, await refreshLeadAssessment(req.user, req.validated.params.id));
}

// GET /api/settings/ai
export async function getAiSettings(req, res) {
  sendOk(res, await getAiSettingsView());
}

// PATCH /api/settings/ai
export async function patchAiSettings(req, res) {
  sendOk(res, await updateAiSettings(req.user, req.validated.body, { requestId: req.id }));
}
