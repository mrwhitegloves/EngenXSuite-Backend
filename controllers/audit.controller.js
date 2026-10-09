import { getAuditFilterOptions, listAuditLogs } from '../services/audit.service.js';
import { sendList, sendOk } from '../lib/respond.js';

// GET /api/audit-logs: who changed what, newest first, with filters and pages.
export async function getAuditLogs(req, res) {
  const { items, pagination } = await listAuditLogs(req.validated.query);
  sendList(res, items, pagination);
}

// GET /api/audit-logs/options: the values the filter dropdowns offer.
export async function getAuditOptions(req, res) {
  sendOk(res, await getAuditFilterOptions());
}
