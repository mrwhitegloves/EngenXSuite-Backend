import {
  ACCOUNT_POTENTIALS,
  Account,
  COMPANY_SIZES,
  RELATIONSHIP_HEALTH,
} from '../models/account.model.js';
import { AccountStatus } from '../models/statusLists.model.js';
import { User } from '../models/user.model.js';
import { SOCKET_EVENTS } from '../constants/socketEvents.js';
import { emitToAll } from '../infra/realtime.js';
import { writeAudit } from '../lib/audit.js';
import { can } from '../lib/can.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { toNameKey } from '../lib/nameKey.js';
import { buildFilter, buildSort, runListQuery } from '../lib/queryBuilder.js';
import { scopeFilter } from '../lib/scopeFilter.js';
import { CODE_SERIES, nextCode } from '../lib/sequence.js';

// Accounts (customer companies). Every function takes the acting user first and enforces what
// that user may see and do:
//   - lists go through scopeFilter(), so a list can never show an account outside the user's scope
//   - a single account outside the scope answers "not found", so its existence is not revealed
//   - a deleted account is hidden everywhere

const FEATURE = 'accounts';
// Sort names the list accepts (validation/accounts.js ACCOUNT_SORTS) → database fields.
const SORT_FIELDS = {
  name: 'name',
  accountCode: 'accountCode',
  createdAt: 'createdAt',
  lastActivityAt: 'lastActivityAt',
};
// Fields that are small objects: a change is merged into what is already saved.
const NESTED_FIELDS = ['hq', 'billingAddress', 'industrial', 'commercial', 'sourceDetail'];
// Shown in full only to someone who may edit the account; masked in lists, views and audit entries.
const SENSITIVE_FIELDS = ['gstin', 'pan'];
// Fields that hold the _id of another record.
const ID_FIELDS = ['ownerId', 'statusId', 'parentAccountId'];
const NOT_DELETED = { deletedAt: null };

const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const asText = (value) => JSON.stringify(value ?? null);
const idText = (value) => (value == null ? null : String(value));

/** "27ABCDE1234F1Z5" → "•••••••••••1Z5": enough to recognise, not enough to copy. */
export function maskSensitive(value) {
  if (!value) return null;
  return `${'•'.repeat(Math.max(value.length - 4, 0))}${value.slice(-4)}`;
}

/** An object without its null, undefined and empty-list entries; undefined when nothing is left. */
function withoutEmpty(object) {
  const entries = Object.entries(object ?? {}).filter(
    ([, value]) =>
      value !== null && value !== undefined && !(Array.isArray(value) && !value.length),
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

const uniqueIds = (ids) => [...new Set(ids.filter(Boolean).map(String))];

/**
 * The names behind the ids on a set of accounts (people, statuses, parent companies), fetched
 * once for the whole set. Accounts store ids only; names are always read from their own record.
 */
async function loadLookups(accounts) {
  const userIds = uniqueIds(
    accounts.flatMap((account) => [account.ownerId, ...(account.assignedUserIds ?? [])]),
  );
  const statusIds = uniqueIds(accounts.map((account) => account.statusId));
  const parentIds = uniqueIds(accounts.map((account) => account.parentAccountId));
  const [users, statuses, parents] = await Promise.all([
    userIds.length
      ? User.find({ _id: { $in: userIds } })
          .select('name')
          .lean()
      : [],
    statusIds.length ? AccountStatus.find({ _id: { $in: statusIds } }).lean() : [],
    parentIds.length
      ? Account.find({ _id: { $in: parentIds }, ...NOT_DELETED })
          .select('name accountCode')
          .lean()
      : [],
  ]);
  const byId = (rows) => new Map(rows.map((row) => [String(row._id), row]));
  return { users: byId(users), statuses: byId(statuses), parents: byId(parents) };
}

const person = (id, lookups) =>
  id ? { id: String(id), name: lookups.users.get(String(id))?.name ?? null } : null;

function statusOf(id, lookups) {
  const status = id && lookups.statuses.get(String(id));
  if (!status) return null;
  return {
    id: String(status._id),
    name: status.name,
    key: status.key,
    color: status.color ?? null,
  };
}

/** One row of the Accounts list: only what the list shows. */
function toListView(account, lookups) {
  return {
    id: String(account._id),
    accountCode: account.accountCode,
    name: account.name,
    industry: account.industry ?? null,
    region: account.region ?? null,
    city: account.hq?.city ?? null,
    status: statusOf(account.statusId, lookups),
    owner: person(account.ownerId, lookups),
    lastActivityAt: account.lastActivityAt ?? null,
    createdAt: account.createdAt,
  };
}

/** The whole account, as one user may see it. */
function toDetailView(account, actor, lookups) {
  const record = { feature: FEATURE, record: account };
  const canEdit = can(actor, 'edit', record);
  const parent = account.parentAccountId && lookups.parents.get(String(account.parentAccountId));
  return {
    id: String(account._id),
    accountCode: account.accountCode,
    name: account.name,
    description: account.description ?? null,
    industry: account.industry ?? null,
    companyType: account.companyType ?? null,
    website: account.website ?? null,
    linkedinUrl: account.linkedinUrl ?? null,
    phone: account.phone ?? null,
    email: account.email ?? null,
    hq: account.hq ?? null,
    region: account.region ?? null,
    companySize: account.companySize ?? null,
    annualRevenuePaise: account.annualRevenuePaise ?? null,
    gstin: canEdit ? (account.gstin ?? null) : maskSensitive(account.gstin),
    pan: canEdit ? (account.pan ?? null) : maskSensitive(account.pan),
    billingAddress: account.billingAddress ?? null,
    status: statusOf(account.statusId, lookups),
    // The group company this one belongs to, if any.
    parent: parent
      ? { id: String(parent._id), name: parent.name, accountCode: parent.accountCode }
      : null,
    industrial: account.industrial ?? null,
    commercial: account.commercial ?? null,
    source: account.source,
    sourceDetail: account.sourceDetail ?? null,
    owner: person(account.ownerId, lookups),
    assignedUsers: (account.assignedUserIds ?? []).map((id) => person(id, lookups)),
    tagIds: (account.tagIds ?? []).map(String),
    lastActivityAt: account.lastActivityAt ?? null,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    // What this user may do with THIS account, so the screen shows only buttons that work.
    permissions: {
      canEdit,
      canDelete: can(actor, 'delete', record),
      canAssign: can(actor, 'assign', record),
    },
  };
}

async function detailOf(account, actor) {
  return toDetailView(account, actor, await loadLookups([account]));
}

/**
 * Load one account for an action. Outside the user's view scope: "not found" (404).
 * Visible but the action is not allowed on it: "forbidden" (403).
 */
async function loadForAction(actor, accountId, action) {
  const account = await Account.findOne({ _id: accountId, ...NOT_DELETED }).lean();
  const record = { feature: FEATURE, record: account };
  if (!account || !can(actor, 'view', record)) throw notFound('Account not found');
  if (action !== 'view' && !can(actor, action, record)) {
    throw forbidden('You do not have permission to do this with this account.');
  }
  return account;
}

async function assertActiveUsers(ids, field) {
  const unique = uniqueIds(ids);
  if (unique.length === 0) return;
  const found = await User.countDocuments({ _id: { $in: unique }, status: 'active' });
  if (found !== unique.length) {
    throw badRequest('Choose active users only', [{ field, message: 'Choose active users only' }]);
  }
}

/** The status a new account gets when none is chosen. */
async function defaultStatusId() {
  const status = await AccountStatus.findOne({ isDefault: true, isActive: true })
    .select('_id')
    .lean();
  if (!status) {
    throw conflict('No account status exists yet. Add one in Settings → Statuses first.');
  }
  return status._id;
}

/** A status can be chosen only while it is active. */
async function assertUsableStatus(statusId) {
  if (!(await AccountStatus.exists({ _id: statusId, isActive: true }))) {
    throw badRequest('Choose a status from the list', [
      { field: 'statusId', message: 'Choose a status from the list' },
    ]);
  }
}

/** A parent must be another existing account, and must not sit below this account itself. */
async function assertUsableParent(parentAccountId, accountId) {
  const fail = (message) => badRequest(message, [{ field: 'parentAccountId', message }]);
  if (accountId && sameId(parentAccountId, accountId)) {
    throw fail('A company cannot be its own parent.');
  }
  // Walk up from the chosen parent; meeting this account on the way would close a circle.
  let currentId = parentAccountId;
  for (let level = 0; level < 20 && currentId; level += 1) {
    const current = await Account.findOne({ _id: currentId, ...NOT_DELETED })
      .select('parentAccountId')
      .lean();
    if (!current) {
      if (level === 0) throw fail('Choose an existing company as the parent.');
      return;
    }
    if (accountId && sameId(current.parentAccountId, accountId)) {
      throw fail('That company already belongs to this one.');
    }
    currentId = current.parentAccountId;
  }
}

/** Refuse a second account with (nearly) the same name unless the person confirmed it. */
async function assertNoDuplicate(actor, nameKey, { exceptId, confirmed }) {
  if (confirmed) return;
  const filter = { nameKey, ...NOT_DELETED };
  if (exceptId) filter._id = { $ne: exceptId };
  const existing = await Account.findOne(filter).select('name ownerId assignedUserIds').lean();
  if (!existing) return;
  const mayOpen = can(actor, 'view', { feature: FEATURE, record: existing });
  throw conflict(`A company with a similar name already exists: "${existing.name}".`, [
    {
      field: 'name',
      message: 'A company with a similar name already exists.',
      code: 'DUPLICATE_NAME',
      // The link is given only to someone who may open that account.
      existingId: mayOpen ? String(existing._id) : null,
    },
  ]);
}

/**
 * @param {object} actor
 * @param {object} query  Already validated (validation/accounts.js listAccountsQuery)
 */
export async function listAccounts(actor, query) {
  const { page, pageSize, sort, search, statusId, industry, region, ownerId, ...dates } = query;
  const filter = buildFilter({
    scope: scopeFilter(actor, FEATURE),
    equals: { statusId, industry, region, ownerId },
    search: { text: search, fields: ['name', 'accountCode', 'hq.city'] },
    dates: { field: 'createdAt', query: dates },
    extra: [NOT_DELETED],
  });
  const { rows, pagination } = await runListQuery(Account, {
    filter,
    sort: buildSort(sort, SORT_FIELDS, '-createdAt'),
    page,
    pageSize,
    select: 'accountCode name industry region hq.city statusId ownerId lastActivityAt createdAt',
  });
  const lookups = await loadLookups(rows);
  return { items: rows.map((row) => toListView(row, lookups)), pagination };
}

/** What the forms and filters offer: the fixed lists, the people, and the values in use. */
export async function getAccountFormOptions(actor) {
  const visible = buildFilter({ scope: scopeFilter(actor, FEATURE), extra: [NOT_DELETED] });
  // Someone who cannot assign may only ever name themselves, so they are not sent the user list.
  const userFilter = can(actor, 'assign', { feature: FEATURE })
    ? { status: 'active' }
    : { _id: actor._id };
  const [users, statuses, industries, regions] = await Promise.all([
    User.find(userFilter).select('name').sort({ name: 1 }).lean(),
    AccountStatus.find().sort({ order: 1 }).lean(),
    Account.distinct('industry', visible),
    Account.distinct('region', visible),
  ]);
  return {
    // Inactive statuses are included (marked), so a filter can still find accounts that have one.
    statuses: statuses.map((status) => ({
      id: String(status._id),
      name: status.name,
      key: status.key,
      color: status.color ?? null,
      isActive: status.isActive,
      isDefault: status.isDefault,
    })),
    companySizes: COMPANY_SIZES,
    accountPotentials: ACCOUNT_POTENTIALS,
    relationshipHealth: RELATIONSHIP_HEALTH,
    users: users.map((user) => ({ id: String(user._id), name: user.name })),
    industries: industries.filter(Boolean).sort(),
    regions: regions.filter(Boolean).sort(),
    canAssign: can(actor, 'assign', { feature: FEATURE }),
  };
}

export async function getAccount(actor, accountId) {
  return detailOf(await loadForAction(actor, accountId, 'view'), actor);
}

/**
 * @param {object} actor
 * @param {object} data  Already validated (validation/accounts.js createAccountBody)
 * @param {{ requestId?: string }} [context]
 */
export async function createAccount(actor, data, context = {}) {
  const { confirmDuplicate, ownerId, assignedUserIds = [], statusId, ...rest } = data;

  // Naming another owner or adding people needs the "assign" permission.
  const namesSomeoneElse = (ownerId && !sameId(ownerId, actor._id)) || assignedUserIds.length > 0;
  if (namesSomeoneElse && !can(actor, 'assign', { feature: FEATURE })) {
    throw forbidden('You cannot choose the owner or assign people.');
  }
  await assertActiveUsers([ownerId], 'ownerId');
  await assertActiveUsers(assignedUserIds, 'assignedUserIds');
  if (statusId) await assertUsableStatus(statusId);
  if (rest.parentAccountId) await assertUsableParent(rest.parentAccountId, null);

  const nameKey = toNameKey(rest.name);
  await assertNoDuplicate(actor, nameKey, { confirmed: confirmDuplicate });
  const chosenStatusId = statusId ?? (await defaultStatusId());

  const fields = { ...rest };
  for (const field of NESTED_FIELDS) fields[field] = withoutEmpty(fields[field]);
  const account = await Account.create({
    ...withoutEmpty(fields),
    // Taken last, after every check passed, so a refused request does not use up a code.
    accountCode: await nextCode(CODE_SERIES.account),
    nameKey,
    statusId: chosenStatusId,
    ownerId: ownerId ?? actor._id,
    assignedUserIds,
    source: 'manual',
    createdBy: actor._id,
  });

  await writeAudit({
    actor,
    action: 'account.created',
    entityType: 'accounts',
    entityId: account._id,
    newValue: {
      accountCode: account.accountCode,
      name: account.name,
      ownerId: String(account.ownerId),
    },
    requestId: context.requestId,
  });
  emitToAll(SOCKET_EVENTS.accountsChanged);
  return detailOf(account.toObject(), actor);
}

/**
 * Change an account. Small objects (hq, billingAddress, industrial, commercial, sourceDetail)
 * are merged: only the parts that are sent change. A null value clears a field.
 * The account code never changes.
 * @param {object} actor
 * @param {string} accountId
 * @param {object} changes  Already validated (validation/accounts.js updateAccountBody)
 * @param {{ requestId?: string }} [context]
 */
export async function updateAccount(actor, accountId, changes, context = {}) {
  const account = await loadForAction(actor, accountId, 'edit');
  const { confirmDuplicate, ...requested } = changes;

  // The value each requested field would have after the change.
  const next = {};
  for (const [field, value] of Object.entries(requested)) {
    next[field] = NESTED_FIELDS.includes(field)
      ? (withoutEmpty({ ...account[field], ...value }) ?? null)
      : value;
  }
  // Keep only what really differs from what is saved (ids are compared as text).
  const comparable = (field, value) => {
    if (field === 'assignedUserIds') return (value ?? []).map(String);
    return ID_FIELDS.includes(field) ? idText(value) : value;
  };
  const changed = Object.keys(next).filter(
    (field) => asText(comparable(field, account[field])) !== asText(comparable(field, next[field])),
  );
  if (changed.length === 0) return detailOf(account, actor);

  const peopleChanged = changed.filter((field) => ['ownerId', 'assignedUserIds'].includes(field));
  if (peopleChanged.length > 0) {
    if (!can(actor, 'assign', { feature: FEATURE, record: account })) {
      throw forbidden('You cannot change the owner or the assigned people.');
    }
    if (changed.includes('ownerId')) await assertActiveUsers([next.ownerId], 'ownerId');
    if (changed.includes('assignedUserIds')) {
      await assertActiveUsers(next.assignedUserIds, 'assignedUserIds');
    }
  }
  if (changed.includes('statusId')) {
    if (next.statusId === null) {
      throw badRequest('An account always has a status', [{ field: 'statusId' }]);
    }
    await assertUsableStatus(next.statusId);
  }
  if (changed.includes('parentAccountId') && next.parentAccountId) {
    await assertUsableParent(next.parentAccountId, account._id);
  }

  const set = {};
  const unset = {};
  for (const field of changed) {
    if (next[field] === null) unset[field] = '';
    else set[field] = next[field];
  }
  if (changed.includes('name')) {
    set.nameKey = toNameKey(next.name);
    if (set.nameKey !== account.nameKey) {
      await assertNoDuplicate(actor, set.nameKey, {
        exceptId: account._id,
        confirmed: confirmDuplicate,
      });
    }
  }

  await Account.updateOne(
    { _id: account._id },
    {
      ...(Object.keys(set).length ? { $set: set } : {}),
      ...(Object.keys(unset).length ? { $unset: unset } : {}),
    },
    { runValidators: true },
  );

  // Audit. Statuses and parent companies are written by name, so the log reads without lookups;
  // sensitive values are masked; who is responsible is recorded apart from ordinary edits.
  const statusNames = changed.includes('statusId')
    ? new Map(
        (await AccountStatus.find({ _id: { $in: [account.statusId, next.statusId] } }).lean()).map(
          (status) => [String(status._id), status.name],
        ),
      )
    : new Map();
  const parentNames = changed.includes('parentAccountId')
    ? new Map(
        (
          await Account.find({
            _id: { $in: [account.parentAccountId, next.parentAccountId].filter(Boolean) },
          })
            .select('name')
            .lean()
        ).map((parent) => [String(parent._id), parent.name]),
      )
    : new Map();
  const auditPair = (field, value) => {
    if (field === 'statusId') return ['status', statusNames.get(idText(value)) ?? null];
    if (field === 'parentAccountId') return ['parent', parentNames.get(idText(value)) ?? null];
    if (SENSITIVE_FIELDS.includes(field)) return [field, maskSensitive(value)];
    return [field, value ?? null];
  };
  const entry = (fields) => ({
    oldValue: Object.fromEntries(fields.map((field) => auditPair(field, account[field]))),
    newValue: Object.fromEntries(fields.map((field) => auditPair(field, next[field]))),
  });
  const otherChanged = changed.filter((field) => !peopleChanged.includes(field));
  const base = {
    actor,
    entityType: 'accounts',
    entityId: account._id,
    requestId: context.requestId,
  };
  if (otherChanged.length > 0) {
    await writeAudit({ ...base, action: 'account.updated', ...entry(otherChanged) });
  }
  if (changed.includes('ownerId')) {
    await writeAudit({ ...base, action: 'account.owner_changed', ...entry(['ownerId']) });
  }
  if (changed.includes('assignedUserIds')) {
    await writeAudit({
      ...base,
      action: 'account.assignment_changed',
      ...entry(['assignedUserIds']),
    });
  }

  emitToAll(SOCKET_EVENTS.accountsChanged);
  return detailOf(await Account.findById(account._id).lean(), actor);
}

// Reasons an account must not be deleted. Each check answers a sentence, or null when it has no
// objection. The phases that add leads and invoices register theirs here.
const deleteBlockers = [];

/** @param {(accountId: unknown) => Promise<string | null>} check */
export function registerAccountDeleteBlocker(check) {
  deleteBlockers.push(check);
  // Returned so a test can take its check out again.
  return () => deleteBlockers.splice(deleteBlockers.indexOf(check), 1);
}

/**
 * Soft delete: the account disappears from every screen but its history stays, and it keeps its
 * code. Refused while something still depends on it (open leads, unpaid invoices, or other
 * companies that name it as their parent).
 */
export async function deleteAccount(actor, accountId, context = {}) {
  const account = await loadForAction(actor, accountId, 'delete');

  const children = await Account.countDocuments({ parentAccountId: account._id, ...NOT_DELETED });
  const reasons = (await Promise.all(deleteBlockers.map((check) => check(account._id)))).filter(
    Boolean,
  );
  if (children > 0) {
    reasons.push(
      `${children} ${children === 1 ? 'company names' : 'companies name'} it as the parent.`,
    );
  }
  if (reasons.length > 0) {
    throw conflict(`This account cannot be deleted yet: ${reasons.join(' ')}`);
  }

  await Account.updateOne(
    { _id: account._id },
    { $set: { deletedAt: new Date(), deletedBy: actor._id } },
  );
  await writeAudit({
    actor,
    action: 'account.deleted',
    entityType: 'accounts',
    entityId: account._id,
    oldValue: { accountCode: account.accountCode, name: account.name },
    requestId: context.requestId,
  });
  emitToAll(SOCKET_EVENTS.accountsChanged);
}
