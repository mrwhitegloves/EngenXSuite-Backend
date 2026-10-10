import { Account } from '../models/account.model.js';
import { Opportunity } from '../models/opportunity.model.js';
import { PipelineStage } from '../models/pipelineStage.model.js';
import { SolutionCategory } from '../models/solutionCategory.model.js';
import { AccountStatus, LeadStatus } from '../models/statusLists.model.js';
import { SOCKET_EVENTS } from '../constants/socketEvents.js';
import { emitToAll } from '../infra/realtime.js';
import { diffFields, writeAudit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { containsPattern } from '../lib/queryBuilder.js';

// The lists managed in Settings (founder decision 0012): account statuses, lead statuses,
// solution categories and pipeline stages. One service for all, because they behave the same way:
//   - names are unique; a status has a fixed `key` that survives a rename
//   - exactly one status is the default for new records
//   - a status in use cannot be deleted (switch it off instead); the default cannot be
//     switched off or deleted
// Pipeline stages differ in two points: they have no default (a new lead starts in the first
// open stage), and each has a type (open, won, lost) and a suggested chance of winning. The
// pipeline always keeps at least one active stage of each type.

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
    // Deleted leads count too: they keep their status.
    countUses: (statusId) => Opportunity.countDocuments({ leadStatusId: statusId }),
  },
  // What the company sells. A plain list: it has no default entry and no fixed key.
  'solution-categories': {
    model: SolutionCategory,
    label: 'solution category',
    entityType: 'solution_categories',
    isPlain: true,
    countUses: (categoryId) => Opportunity.countDocuments({ solutionCategoryIds: categoryId }),
  },
  // The steps a lead moves through. The stage of a lead is changed only by the stage service.
  'pipeline-stages': {
    model: PipelineStage,
    label: 'pipeline stage',
    entityType: 'pipeline_stages',
    isStages: true,
    countUses: (stageId) => Opportunity.countDocuments({ stageId }),
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
    // Pipeline stages only.
    ...(status.type
      ? { type: status.type, defaultProbability: status.defaultProbability ?? null }
      : {}),
  };
}

/** The pipeline must keep one active stage of each type: refuse to take away the last one. */
async function assertNotLastOfType(stage) {
  const others = await PipelineStage.countDocuments({
    _id: { $ne: stage._id },
    type: stage.type,
    isActive: true,
  });
  if (stage.isActive && others === 0) {
    throw conflict(
      `This is the only active "${stage.type}" stage. The pipeline needs at least one; add another first.`,
    );
  }
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
 * @param {{ name: string, color?: string | null, type?: string, defaultProbability?: number | null }} data
 *        Already validated. type and defaultProbability are for pipeline stages only.
 */
export async function createStatus(actor, listKey, data, context = {}) {
  const { model, entityType, isPlain, isStages } = STATUS_LISTS[listKey];
  if (!isStages && (data.type !== undefined || data.defaultProbability !== undefined)) {
    throw badRequest('Only pipeline stages have a type and a chance of winning.');
  }
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
        }),
    ...(isStages
      ? { type: data.type ?? 'open', defaultProbability: data.defaultProbability ?? undefined }
      : // The very first status of a list becomes its default.
        isPlain
        ? {}
        : { isDefault: isFirst }),
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
  const { model, entityType, isPlain, isStages, countUses } = STATUS_LISTS[listKey];
  const status = await model.findById(statusId).lean();
  if (!status) throw notFound('Status not found');
  if (isPlain && (changes.isDefault !== undefined || changes.color !== undefined)) {
    throw badRequest('This list has no default entry and no colours.');
  }
  if (isStages && changes.isDefault !== undefined) {
    throw badRequest(
      'The pipeline has no default stage: a new lead starts in the first open stage.',
    );
  }
  if (!isStages && (changes.type !== undefined || changes.defaultProbability !== undefined)) {
    throw badRequest('Only pipeline stages have a type and a chance of winning.');
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

  if (isStages && (newValue.isActive === false || newValue.type !== undefined)) {
    await assertNotLastOfType(status);
  }
  if (isStages && newValue.type !== undefined && (await countUses(status._id)) > 0) {
    // Leads keep a copy of their stage's type (open, won, lost); it must stay true.
    throw conflict('Leads are in this stage, so its type cannot change. Add a new stage instead.');
  }

  if (newValue.isDefault === true) {
    // Exactly one default: the others give it up in the same step.
    await model.updateMany({ _id: { $ne: status._id } }, { $set: { isDefault: false } });
  }
  const set = { ...newValue };
  const unset = {};
  for (const field of ['color', 'defaultProbability']) {
    if (set[field] === null) {
      delete set[field];
      unset[field] = '';
    }
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
  const { model, entityType, countUses, label, isStages } = STATUS_LISTS[listKey];
  const status = await model.findById(statusId).lean();
  if (!status) throw notFound('Status not found');
  if (isStages) await assertNotLastOfType(status);
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
