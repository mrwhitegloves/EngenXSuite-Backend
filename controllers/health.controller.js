import { getHealth } from '../services/health.service.js';
import { sendOk } from '../lib/respond.js';

// GET /api/health/live: is the process running? No dependencies checked.
export function getLiveness(req, res) {
  sendOk(res, { status: 'ok' });
}

// GET /api/health: can the app do its job? 503 tells the platform and the uptime monitor it cannot.
export async function getReadiness(req, res) {
  const health = await getHealth();
  res.status(health.status === 'ok' ? 200 : 503).json({ data: health });
}
