import { Account } from '../models/account.model.js';
import { SolutionCategory } from '../models/solutionCategory.model.js';
import { AccountStatus, LeadStatus } from '../models/statusLists.model.js';
import { SOCKET_EVENTS } from '../constants/socketEvents.js';
import { emitToAll } from '../infra/realtime.js';
import { diffFields, writeAudit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { containsPattern } from '../lib/queryBuilder.js';

// The status lists managed in Settings → Statuses (founder decision 0012): account statuses and
// lead statuses. One service for both, because they behave the same way:
//   - names are unique; a status has a fixed `key` that survives a rename
//   - exactly one status is the default for new records
//   - a status in use cannot be deleted (switch it off instead); the default cannot be
//     switched off or deleted

export const STATUS_LISTS = {
  'account-statuses': {
    model: AccountStatus,
    label: 'account status',
    entityType: 'account_statuses',
    // Deleted accounts count too: they keep their status and may be looked at again.
    countUses: (statusId) => Account.countDocuments({ statusId }),
  },
  'lead-statuses': {
    model: LeadStatus,
    label: 'lead status',
    entityType: 'lead_statuses',
    // Leads arrive in the next phase; until then no record can use a lead status.
    countUses: async () => 0,
  },
  // What the company sells. A plain list: it has no default entry and no fixed key.
  'solution-categories': {
    model: SolutionCategory,
    label: 'solution category',
    entityType: 'solution_categories',
    isPlain: true,
    // Leads carry solution categories; they arrive in the next phase.
    countUses: async () => 0,
  },
};
export const STATUS_LIST_KEYS = Object.keys(STATUS_LISTS);

function toView(status) {
  return {
    id: String(status._id),
    name: status.name,
    key: status.key ?? null,
    color: status.color ?? null,
    order: status.order ?? 0,
    isActive: status.isActive,
    isDefault: status.isDefault ?? false,
  };
}

/** "Contact Attempt 1" → "contact_attempt_1". */
const toKey = (name) =>
  name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');

async function assertNameIsFree(model, name, exceptId) {
  // The whole name, any letter case: "won" and "Won" are the same status.
  const pattern = new RegExp(`^${containsPattern(name).source}$`, 'i');
  const filter = { name: pattern };
  if (exceptId) filter._id = { $ne: exceptId };
  if (await model.exists(filter)) {
    throw conflict('A status with this name already exists.', [{ field: 'name' }]);
  }
}

const announce = () => emitToAll(SOCKET_EVENTS.statusListsChanged);

/** Every status of one list, in order. Inactive ones are included and marked. */
export async function listStatuses(listKey) {
  const statuses = await STATUS_LISTS[listKey].model.find().sort({ order: 1, _id: 1 }).lean();
  return statuses.map(toView);
}

/**
 * @param {object} actor
 * @param {string} listKey  One of STATUS_LIST_KEYS
 * @param {{ name: string, color?: string | null }} data  Already validated
 */
export async function createStatus(actor, listKey, data, context = {}) {
  const { model, entityType, isPlain } = STATUS_LISTS[listKey];
  await assertNameIsFree(model, data.name);

  // The key must be unique for ever, also against keys of renamed statuses.
  const baseKey = toKey(data.name) || 'status';
  let key = baseKey;
  for (let number = 2; !isPlain && (await model.exists({ key })); number += 1) {
    key = `${baseKey}_${number}`;
  }

  const last = await model.findOne().sort({ order: -1 }).select('order').lean();
  const isFirst = !(await model.exists({}));
  const status = await model.create({
    name: data.name,
    order: (last?.order ?? 0) + 10,
    // A plain list has neither a key nor a default, and no colour.
    ...(isPlain
      ? {}
      : {
          key,
          color: data.color ?? undefined,
          // The very first status of a list becomes its default.
          isDefault: isFirst,
        }),
  });
  await writeAudit({
    actor,
    action: 'status.created',
    entityType,
    entityId: status._id,
    newValue: { name: status.name },
    requestId: context.requestId,
  });
  announce();
  return toView(status.toObject());
}

/**
 * Rename, recolour, switch on or off, or make the default.
 * @param {{ name?: string, color?: string | null, isActive?: boolean, isDefault?: true }} changes
 */
export async function updateStatus(actor, listKey, statusId, changes, context = {}) {
  const { model, entityType, isPlain } = STATUS_LISTS[listKey];
  const status = await model.findById(statusId).lean();
  if (!status) throw notFound('Status not found');
  if (isPlain && (changes.isDefault !== undefined || changes.color !== undefined)) {
    throw badRequest('This list has no default entry and no colours.');
  }

  const { oldValue, newValue, changed } = diffFields(status, changes);
  if (!changed) return toView(status);

  if (newValue.name !== undefined) await assertNameIsFree(model, newValue.name, status._id);
  const willBeDefault = newValue.isDefault ?? status.isDefault;
  const willBeActive = newValue.isActive ?? status.isActive;
  if (willBeDefault && !willBeActive) {
    throw conflict(
      'The default status cannot be switched off. Make another one the default first.',
    );
  }

  if (newValue.isDefault === true) {
    // Exactly one default: the others give it up in the same step.
    await model.updateMany({ _id: { $ne: status._id } }, { $set: { isDefault: false } });
  }
  const set = { ...newValue };
  const unset = {};
  if (set.color === null) {
    delete set.color;
    unset.color = '';
  }
  await model.updateOne(
    { _id: status._id },
    {
      ...(Object.keys(set).length ? { $set: set } : {}),
      ...(Object.keys(unset).length ? { $unset: unset } : {}),
    },
  );
  await writeAudit({
    actor,
    action: 'status.updated',
    entityType,
    entityId: status._id,
    oldValue,
    newValue,
    requestId: context.requestId,
  });
  announce();
  return toView(await model.findById(status._id).lean());
}

/**
 * Put the statuses of a list in a new order.
 * @param {string[]} orderedIds  Every status id of the list, in the wanted order
 */
export async function reorderStatuses(actor, listKey, orderedIds, context = {}) {
  const { model, entityType } = STATUS_LISTS[listKey];
  const existing = (await model.find().select('_id').lean()).map((status) => String(status._id));
  const sameSet =
    existing.length === orderedIds.length && existing.every((id) => orderedIds.includes(id));
  if (!sameSet) {
    throw badRequest('Send every status of the list exactly once', [{ field: 'ids' }]);
  }
  await model.bulkWrite(
    orderedIds.map((id, index) => ({
      updateOne: { filter: { _id: id }, update: { $set: { order: (index + 1) * 10 } } },
    })),
  );
  await writeAudit({
    actor,
    action: 'status.reordered',
    entityType,
    // The audit log needs one record id; the first status of the new order stands for the list.
    entityId: orderedIds[0],
    requestId: context.requestId,
  });
  announce();
  return listStatuses(listKey);
}

/** Delete a status that no record uses and that is not the default. */
export async function deleteStatus(actor, listKey, statusId, context = {}) {
  const { model, entityType, countUses, label } = STATUS_LISTS[listKey];
  const status = await model.findById(statusId).lean();
  if (!status) throw notFound('Status not found');
  if (status.isDefault) {
    throw conflict('The default status cannot be deleted. Make another one the default first.');
  }
  const uses = await countUses(status._id);
  if (uses > 0) {
    throw conflict(
      `${uses} ${uses === 1 ? 'record has' : 'records have'} this ${label}. Switch it off instead; it then disappears from pickers but stays on those records.`,
    );
  }
  await model.deleteOne({ _id: status._id });
  await writeAudit({
    actor,
    action: 'status.deleted',
    entityType,
    entityId: status._id,
    oldValue: { name: status.name },
    requestId: context.requestId,
  });
  announce();
}
