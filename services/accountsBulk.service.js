import { toCsv } from '../lib/csv.js';
import { writeAudit } from '../lib/audit.js';
import { can } from '../lib/can.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { scopeFilter } from '../lib/scopeFilter.js';
import { Account } from '../models/account.model.js';
import { Contact } from '../models/contact.model.js';
import { Opportunity } from '../models/opportunity.model.js';
import { User } from '../models/user.model.js';
import { loadAccountListLookups, updateAccount } from './accounts.service.js';

// What is done with MANY companies at once, chosen on the Accounts screen: give them to
// people, and take them out as a file. (A bundle from them: services/bundles.service.js.)
// Every company is still handled by the normal rules: only companies inside the actor's scope
// are touched, and an owner is set through updateAccount(), so each change is audited and the
// company's leads follow the new owner.

export const MAX_BULK_ACCOUNTS = 2000;
const NOT_DELETED = { deletedAt: null };

/**
 * Give companies to people: all to one person, or one after the other to several (round robin).
 * A company that has an owner gets the new one (founder, 2026-10-31: bulk assign also moves
 * companies); only a company that already belongs to the chosen person is skipped.
 * @param {{ accountIds: string[], userIds: string[] }} request  Validated. One user: all go
 *        to that person. Several: they take turns, in the order given.
 */
export async function bulkAssignAccounts(actor, { accountIds, userIds }, context = {}) {
  if (!can(actor, 'assign', { feature: 'accounts' })) {
    throw forbidden('You do not have permission to assign companies.');
  }
  const users = await User.find({ _id: { $in: userIds }, status: 'active' })
    .select('name')
    .lean();
  const byId = new Map(users.map((user) => [String(user._id), user]));
  // In the order the person chose them.
  const turn = [...new Set(userIds)].map((id) => byId.get(id)).filter(Boolean);
  if (turn.length === 0)
    throw badRequest('Choose at least one active user.', [{ field: 'userIds' }]);

  const accounts = await Account.find({
    $and: [
      { _id: { $in: accountIds } },
      scopeFilter(actor, 'accounts', { action: 'edit' }),
      NOT_DELETED,
    ],
  })
    .select('name ownerId')
    .sort({ createdAt: 1, _id: 1 })
    .lean();
  const counts = new Map(turn.map((user) => [String(user._id), 0]));
  const skipped = [];
  const failed = [];
  let next = 0;
  for (const account of accounts) {
    const user = turn[next % turn.length];
    if (String(account.ownerId ?? '') === String(user._id)) {
      skipped.push(account.name);
      continue;
    }
    try {
      await updateAccount(actor, String(account._id), { ownerId: String(user._id) }, context);
      counts.set(String(user._id), counts.get(String(user._id)) + 1);
      next += 1;
    } catch (error) {
      failed.push({
        name: account.name,
        reason: String(error?.message ?? 'Could not be assigned'),
      });
    }
  }
  return {
    assigned: next,
    // Already with the person whose turn it was: nothing to change.
    skipped: skipped.length,
    skippedNames: skipped.slice(0, 20),
    failed,
    // Chosen, but not the actor's to change (or deleted meanwhile).
    notFound: accountIds.length - accounts.length,
    perUser: turn.map((user) => ({ name: user.name, count: counts.get(String(user._id)) })),
  };
}

const day = (value) =>
  value ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(value) : '';

// One row per company, in the order a person reads a company: who it is, where, whose it is,
// how to reach it, its main person, and what is open with it. Never GSTIN or PAN.
const SELECTED_COLUMNS = [
  { header: 'Company code', value: (row) => row.accountCode },
  { header: 'Company name', value: (row) => row.name },
  { header: 'Industry', value: (row) => row.industry },
  { header: 'City', value: (row) => row.hq?.city },
  { header: 'State', value: (row) => row.hq?.state },
  { header: 'Status', value: (row) => row.status },
  { header: 'Owner', value: (row) => row.owner },
  { header: 'Company phone', value: (row) => row.phone_number },
  { header: 'Company email', value: (row) => row.email },
  { header: 'Website', value: (row) => row.website },
  { header: 'Main contact', value: (row) => row.contact?.name },
  { header: 'Designation', value: (row) => row.contact?.designation },
  { header: 'Contact phone', value: (row) => row.contact?.phone_number },
  { header: 'Contact email', value: (row) => row.contact?.email },
  { header: 'People in the CRM', value: (row) => row.people },
  { header: 'Open leads', value: (row) => row.openLeads },
  { header: 'Tags', value: (row) => row.tags },
  { header: 'Last activity', value: (row) => day(row.lastActivityAt) },
  { header: 'Created on', value: (row) => day(row.createdAt) },
];

/**
 * The chosen companies as a CSV file, each with its main person. Only companies inside the
 * actor's EXPORT scope; the export is written to the audit log.
 * @param {{ accountIds: string[] }} request  Validated
 */
export async function exportSelectedAccounts(actor, { accountIds }, context = {}) {
  const accounts = await Account.find({
    $and: [
      { _id: { $in: accountIds } },
      scopeFilter(actor, 'accounts', { action: 'export' }),
      NOT_DELETED,
    ],
  })
    .sort({ name: 1 })
    .lean();
  const ids = accounts.map((account) => account._id);
  const [lookups, contacts, leads] = await Promise.all([
    loadAccountListLookups(accounts),
    Contact.find({ accountId: { $in: ids }, ...NOT_DELETED })
      .select('name designation phone_number email accountId')
      .sort({ createdAt: 1 })
      .lean(),
    Opportunity.aggregate([
      { $match: { accountId: { $in: ids }, status: 'open', deletedAt: null } },
      { $group: { _id: '$accountId', count: { $sum: 1 } } },
    ]),
  ]);
  const people = new Map();
  for (const contact of contacts) {
    const key = String(contact.accountId);
    people.set(key, [...(people.get(key) ?? []), contact]);
  }
  const open = new Map(leads.map((item) => [String(item._id), item.count]));
  const rows = accounts.map((account) => {
    const list = people.get(String(account._id)) ?? [];
    return {
      ...account,
      status: lookups.status(account.statusId),
      owner: lookups.owner(account.ownerId),
      tags: lookups.tags(account.tagIds),
      // The first person that was added is taken as the main one.
      contact: list[0],
      people: list.length,
      openLeads: open.get(String(account._id)) ?? 0,
    };
  });
  await writeAudit({
    actor,
    action: 'account.exported',
    entityType: 'users',
    entityId: actor._id,
    newValue: { accounts: rows.length, selected: true },
    requestId: context.requestId,
  });
  return { csv: toCsv(SELECTED_COLUMNS, rows), count: rows.length };
}
