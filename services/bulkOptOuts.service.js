import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { writeAudit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { normalizePhone } from '../lib/phone.js';
import { containsPattern, runListQuery } from '../lib/queryBuilder.js';
import { BulkOptOut } from '../models/bulkOptOut.model.js';
import { User } from '../models/user.model.js';

// "Do not write to in bulk" (docs/BULK.md): the addresses and numbers that never get a bulk
// mail or a bulk WhatsApp message. One list for the whole company. A normal, single mail or
// message to that person is not touched by it.
//
// A customer puts their own address on the list with the link at the foot of a bulk mail.
// The link carries the address and a signature of the server, so nobody can stop the mails of
// an address they only guess.

const isEmail = (text) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);

/** The one form an address is kept in, or null when it is not usable. */
export function cleanAddress(channel, address) {
  if (channel === 'email') {
    const email = String(address ?? '')
      .trim()
      .toLowerCase();
    return isEmail(email) ? email : null;
  }
  return normalizePhone(address);
}

/**
 * Which of these addresses must not get a bulk message.
 * @param {'email' | 'whatsapp'} channel
 * @param {(string | null | undefined)[]} addresses
 * @returns {Promise<Set<string>>} The stopped ones, in their kept form
 */
export async function findOptedOut(channel, addresses) {
  const clean = [...new Set(addresses.map((item) => cleanAddress(channel, item)).filter(Boolean))];
  if (clean.length === 0) return new Set();
  const rows = await BulkOptOut.find({ channel, address: { $in: clean } })
    .select('address')
    .lean();
  return new Set(rows.map((row) => row.address));
}

export async function isOptedOut(channel, address) {
  const clean = cleanAddress(channel, address);
  return clean ? (await findOptedOut(channel, [clean])).has(clean) : false;
}

/** Put an address on the list. Doing it twice changes nothing. @returns the stored row */
async function saveOptOut({ channel, address, source, note, createdBy }) {
  return BulkOptOut.findOneAndUpdate(
    { channel, address },
    { $setOnInsert: { channel, address, source, note, createdBy } },
    { upsert: true, returnDocument: 'after' },
  ).lean();
}

/**
 * @param {{ search?: string, channel?: string, page: number, pageSize: number }} query  Validated
 */
export async function listOptOuts(query) {
  const { rows, pagination } = await runListQuery(BulkOptOut, {
    filter: {
      ...(query.channel ? { channel: query.channel } : {}),
      ...(query.search ? { address: containsPattern(query.search) } : {}),
    },
    sort: { createdAt: -1, _id: -1 },
    page: query.page,
    pageSize: query.pageSize,
  });
  const users = await User.find({ _id: { $in: rows.map((row) => row.createdBy).filter(Boolean) } })
    .select('name')
    .lean();
  const names = new Map(users.map((user) => [String(user._id), user.name]));
  return {
    items: rows.map((row) => ({
      id: String(row._id),
      channel: row.channel,
      address: row.address,
      source: row.source,
      note: row.note ?? null,
      addedBy: names.get(String(row.createdBy)) ?? null,
      createdAt: row.createdAt,
    })),
    pagination,
  };
}

/** One of us puts an address or a number on the list. */
export async function addOptOut(actor, { channel, address, note }, context = {}) {
  const clean = cleanAddress(channel, address);
  if (!clean) {
    throw badRequest(
      channel === 'email' ? 'This is not an email address.' : 'This is not a phone number.',
    );
  }
  const row = await saveOptOut({
    channel,
    address: clean,
    source: 'person',
    note,
    createdBy: actor._id,
  });
  await writeAudit({
    actor,
    action: 'bulk_opt_out.added',
    entityType: 'bulk_opt_outs',
    entityId: row._id,
    newValue: { channel, address: clean },
    requestId: context.requestId,
  });
  return { channel, address: clean };
}

/** Take an address off the list: it gets bulk messages again. */
export async function removeOptOut(actor, optOutId, context = {}) {
  const removed = await BulkOptOut.findByIdAndDelete(optOutId).lean();
  if (!removed) throw notFound('This address is not on the list');
  await writeAudit({
    actor,
    action: 'bulk_opt_out.removed',
    entityType: 'bulk_opt_outs',
    entityId: removed._id,
    oldValue: { channel: removed.channel, address: removed.address, source: removed.source },
    requestId: context.requestId,
  });
}

/** The customer wrote STOP on WhatsApp. */
export async function optOutByMessage(phone) {
  const clean = cleanAddress('whatsapp', phone);
  if (clean) await saveOptOut({ channel: 'whatsapp', address: clean, source: 'message' });
}

// ── The link at the foot of a bulk mail ─────────────────────────────────────────────────────

// The session secret, under its own label: such a link can never pass for anything else.
const sign = (email) =>
  createHmac('sha256', env.SESSION_SECRET).update(`bulk-stop:${email}`).digest('base64url');

/** The address a customer opens to stop bulk mails to this email. */
export function stopLinkFor(email) {
  const clean = cleanAddress('email', email);
  return `${env.APP_URL}/stop-mail/${Buffer.from(clean).toString('base64url')}.${sign(clean)}`;
}

/** @returns {string} The email of a genuine link; "not found" for anything else */
function readStopToken(token) {
  const [encoded, signature, ...rest] = String(token ?? '').split('.');
  const email = encoded ? Buffer.from(encoded, 'base64url').toString('utf8') : '';
  const expected = Buffer.from(sign(email));
  const given = Buffer.from(signature ?? '');
  const isGenuine =
    rest.length === 0 &&
    cleanAddress('email', email) === email &&
    expected.length === given.length &&
    timingSafeEqual(expected, given);
  if (!isGenuine) throw notFound('This link is not valid');
  return email;
}

/** For the page behind the link: whose mails, and whether they are stopped already. */
export async function getStopPage(token) {
  const email = readStopToken(token);
  return { email, isStopped: await isOptedOut('email', email) };
}

/** The customer presses the button on that page. */
export async function stopByLink(token) {
  const email = readStopToken(token);
  await saveOptOut({ channel: 'email', address: email, source: 'link' });
  return { email, isStopped: true };
}
