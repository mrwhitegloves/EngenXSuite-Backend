import { Account } from '../models/account.model.js';
import { AuditLog } from '../models/auditLog.model.js';
import { Contact } from '../models/contact.model.js';
import { Machine } from '../models/machine.model.js';
import { Plant } from '../models/plant.model.js';
import { Role } from '../models/role.model.js';
import { AccountStatus, LeadStatus } from '../models/statusLists.model.js';
import { User } from '../models/user.model.js';
import { buildFilter, runListQuery } from '../lib/queryBuilder.js';

// Reading the audit log (Master Prompt Section 54). Read-only: nothing here writes, changes or
// deletes an entry. Entries are written only by writeAudit() in lib/audit.js.

// Which collection gives a readable name for the record an entry is about.
const NAME_SOURCES = {
  users: { model: User, field: 'name' },
  roles: { model: Role, field: 'name' },
  accounts: { model: Account, field: 'name' },
};

// Record types of which there is only one: they have a fixed name instead of a lookup.
const FIXED_NAMES = { settings: 'Product settings' };

async function loadNames(model, field, ids) {
  if (ids.length === 0) return new Map();
  const rows = await model
    .find({ _id: { $in: ids } })
    .select(field)
    .lean();
  return new Map(rows.map((row) => [String(row._id), row[field]]));
}

/**
 * @param {{ page: number, pageSize: number, userId?: string, entityType?: string, action?: string,
 *           range?: string, from?: string, to?: string }} query  Already validated
 */
export async function listAuditLogs({ page, pageSize, userId, entityType, action, ...dates }) {
  const filter = buildFilter({
    equals: { entityType, action },
    dates: { field: 'at', query: dates },
    // "system" means entries without a user.
    extra: userId ? [{ userId: userId === 'system' ? null : userId }] : [],
  });
  const { rows: entries, pagination } = await runListQuery(AuditLog, {
    filter,
    sort: { at: -1, _id: -1 },
    page,
    pageSize,
  });

  // Names for "who" and for "which record", looked up once for the whole page.
  const idsOf = (type) =>
    entries.filter((entry) => entry.entityType === type).map((entry) => entry.entityId);
  const actorIds = entries.map((entry) => entry.userId).filter(Boolean);
  const [
    userNames,
    roleNames,
    accountNames,
    accountStatusNames,
    leadStatusNames,
    contactNames,
    plantNames,
    machineNames,
  ] = await Promise.all([
    loadNames(User, NAME_SOURCES.users.field, [...actorIds, ...idsOf('users')]),
    loadNames(Role, NAME_SOURCES.roles.field, idsOf('roles')),
    // A deleted account keeps its name here: the log must still say what was deleted.
    loadNames(Account, NAME_SOURCES.accounts.field, idsOf('accounts')),
    loadNames(AccountStatus, 'name', idsOf('account_statuses')),
    loadNames(LeadStatus, 'name', idsOf('lead_statuses')),
    loadNames(Contact, 'name', idsOf('contacts')),
    loadNames(Plant, 'name', idsOf('plants')),
    loadNames(Machine, 'name', idsOf('machines')),
  ]);
  const entityNames = {
    users: userNames,
    roles: roleNames,
    accounts: accountNames,
    account_statuses: accountStatusNames,
    lead_statuses: leadStatusNames,
    contacts: contactNames,
    plants: plantNames,
    machines: machineNames,
  };

  const items = entries.map((entry) => ({
    id: String(entry._id),
    at: entry.at,
    action: entry.action,
    // null: done by the system itself. A name of null: that user no longer exists.
    user: entry.userId
      ? { id: String(entry.userId), name: userNames.get(String(entry.userId)) ?? null }
      : null,
    entityType: entry.entityType,
    entityId: String(entry.entityId),
    entityName:
      FIXED_NAMES[entry.entityType] ??
      entityNames[entry.entityType]?.get(String(entry.entityId)) ??
      null,
    oldValue: entry.oldValue ?? null,
    newValue: entry.newValue ?? null,
  }));
  return { items, pagination };
}

/** What the filter dropdowns offer: the users, record types and actions that exist. */
export async function getAuditFilterOptions() {
  const [users, entityTypes, actions] = await Promise.all([
    User.find().select('name').sort({ name: 1 }).lean(),
    AuditLog.distinct('entityType'),
    AuditLog.distinct('action'),
  ]);
  return {
    users: users.map((user) => ({ id: String(user._id), name: user.name })),
    entityTypes: entityTypes.sort(),
    actions: actions.sort(),
  };
}
