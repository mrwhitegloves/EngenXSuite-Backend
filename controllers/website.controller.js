import { sendList, sendOk } from '../lib/respond.js';
import {
  getWebsiteOverview,
  getWebsiteStatus,
  listWebsiteLeads,
  listWebsiteSessions,
} from '../services/websiteAnalytics.service.js';

// The Website screen. Each function: read the validated request, call one service function, respond.

// GET /api/website/status: is the website's database connected.
export function getStatus(req, res) {
  sendOk(res, getWebsiteStatus());
}

// GET /api/website/analytics/overview: totals, traffic, pages, devices, sources.
export async function getOverview(req, res) {
  sendOk(res, await getWebsiteOverview(req.validated.query));
}

// GET /api/website/analytics/sessions: one row per visitor.
export async function getSessions(req, res) {
  const { items, pagination } = await listWebsiteSessions(req.validated.query);
  sendList(res, items, pagination);
}

// GET /api/website/analytics/leads: the website's contact-form leads.
export async function getLeads(req, res) {
  const { items, pagination } = await listWebsiteLeads(req.validated.query);
  sendList(res, items, pagination);
}
