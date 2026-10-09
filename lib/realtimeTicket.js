import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

// A short-lived pass for opening the live-update connection (decision 0008).
// In production the browser reaches the API through the client's address, but the live
// connection goes straight to the server's own address, where the session cookie is not sent.
// So the browser first asks the API (with its session) for a ticket, and shows it when it
// connects. A ticket says only "this user, until this moment" and is signed by the server.

export const TICKET_LIFETIME_SECONDS = 60;

// The session secret, used under a different label so a ticket can never pass for anything else.
const sign = (payload) =>
  createHmac('sha256', env.SESSION_SECRET).update(`realtime-ticket:${payload}`).digest('base64url');

/** @returns {string} "<userId>.<expiry in ms>.<signature>" */
export function createTicket(userId, now = Date.now()) {
  const payload = `${userId}.${now + TICKET_LIFETIME_SECONDS * 1000}`;
  return `${payload}.${sign(payload)}`;
}

/**
 * @returns {string | null} The user id when the ticket is genuine and not expired, else null
 */
export function verifyTicket(ticket, now = Date.now()) {
  if (typeof ticket !== 'string' || ticket.length > 200) return null;
  const parts = ticket.split('.');
  if (parts.length !== 3) return null;
  const [userId, expiresAt, signature] = parts;

  const expected = Buffer.from(sign(`${userId}.${expiresAt}`));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (!/^\d+$/.test(expiresAt) || Number(expiresAt) <= now) return null;
  return userId;
}
