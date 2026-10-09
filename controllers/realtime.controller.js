import { env } from '../config/env.js';
import { TICKET_LIFETIME_SECONDS, createTicket } from '../lib/realtimeTicket.js';
import { sendOk } from '../lib/respond.js';

// GET /api/realtime/ticket: a short-lived pass for the live-update connection, and the address
// to connect to (null = the same address as the page, which is the case in development).
export async function getRealtimeTicket(req, res) {
  sendOk(res, {
    ticket: createTicket(String(req.user._id)),
    url: env.REALTIME_URL ?? null,
    expiresInSeconds: TICKET_LIFETIME_SECONDS,
  });
}
