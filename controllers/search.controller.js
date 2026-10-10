import { getTodayDashboard } from '../services/dashboards.service.js';
import { searchEverything } from '../services/search.service.js';
import { sendOk } from '../lib/respond.js';

// Global search and the dashboard.
// Each function: read the validated request, call one service function, respond.

// GET /api/search?q=…
export async function getSearch(req, res) {
  sendOk(res, await searchEverything(req.user, req.validated.query));
}

// GET /api/dashboard/today
export async function getDashboardToday(req, res) {
  sendOk(res, await getTodayDashboard(req.user));
}
