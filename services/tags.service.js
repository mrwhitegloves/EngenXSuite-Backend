import { Account } from '../models/account.model.js';
import { Contact } from '../models/contact.model.js';
import { TAG_TARGETS, Tag } from '../models/tag.model.js';
import { SOCKET_EVENTS } from '../constants/socketEvents.js';
import { emitToAll } from '../infra/realtime.js';
import { writeAudit } from '../lib/audit.js';
import { planChanges, toUpdate } from '../lib/changes.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';

// Tags: the ONE place tags are created, renamed, merged and deleted (Master Prompt Section 12).
// Records only hold tag ids. That is why these four operations work everywhere at once:
//   rename : the name is read from here, so every record shows the new one
//   delete : the id is pulled out of every record in the same function
//   merge  : records of the tag that goes away get the tag that stays, then the first is deleted

// Every collection that carries tagIds. A new one (leads) is added to this list and nowhere else.
const TAGGED_MODELS = [Account, Contact];

const toKey = (name) => name.trim().toLowerCase().replace(/\s+/g, ' ');
const announce = () => emitToAll(SOCKET_EVENTS.tagsChanged);

function toView(tag, uses) {
  return {
    id: String(tag._id),
    name: tag.name,
    color: tag.color ?? null,
    appliesTo: tag.appliesTo?.length ? tag.appliesTo : TAG_TARGETS,
    // How many records carry the tag; given only when asked for (the Settings screen).
    ...(uses === undefined ? {} : { uses }),
  };
}

async function countUses(tagId) {
  const counts = await Promise.all(
    TAGGED_MODELS.map((model) => model.countDocuments({ tagIds: tagId, deletedAt: null })),
  );
  return counts.reduce((sum, count) => sum + count, 0);
}

async function assertNameIsFree(key, exceptId) {
  const filter = { key };
  if (exceptId) filter._id = { $ne: exceptId };
  if (await Tag.exists(filter)) {
    throw conflict('A tag with this name already exists.', [{ field: 'name' }]);
  }
}

/** Every tag by name. `withUses` adds how many records carry each one. */
export async function listTags({ withUses = false } = {}) {
  const tags = await Tag.find().sort({ key: 1 }).lean();
  if (!withUses) return tags.map((tag) => toView(tag));
  return Promise.all(tags.map(async (tag) => toView(tag, await countUses(tag._id))));
}

/** @param {{ name: string, color?: string | null, appliesTo?: string[] }} data  Validated */
export async function createTag(actor, data, context = {}) {
  const key = toKey(data.name);
  await assertNameIsFree(key);
  const tag = await Tag.create({
    name: data.name,
    key,
    color: data.color ?? undefined,
    appliesTo: data.appliesTo?.length ? data.appliesTo : TAG_TARGETS,
    createdBy: actor._id,
  });
  await writeAudit({
    actor,
    action: 'tag.created',
    entityType: 'tags',
    entityId: tag._id,
    newValue: { name: tag.name },
    requestId: context.requestId,
  });
  announce();
  return toView(tag.toObject());
}

/** Rename, recolour, or change where the tag is offered. */
export async function updateTag(actor, tagId, changes, context = {}) {
  const tag = await Tag.findById(tagId).lean();
  if (!tag) throw notFound('Tag not found');

  const plan = planChanges(tag, changes);
  if (plan.fields.includes('name')) {
    plan.set.key = toKey(plan.newValue.name);
    await assertNameIsFree(plan.set.key, tag._id);
  }
  const update = toUpdate(plan);
  if (update) {
    await Tag.updateOne({ _id: tag._id }, update, { runValidators: true });
    await writeAudit({
      actor,
      action: 'tag.updated',
      entityType: 'tags',
      entityId: tag._id,
      oldValue: plan.oldValue,
      newValue: plan.newValue,
      requestId: context.requestId,
    });
    announce();
  }
  return toView(await Tag.findById(tag._id).lean());
}

/** Delete a tag and take it off every record that carries it. */
export async function deleteTag(actor, tagId, context = {}) {
  const tag = await Tag.findById(tagId).lean();
  if (!tag) throw notFound('Tag not found');

  // Off the records first: if this stops half-way, no record points at a tag that is gone.
  const removedFrom = await pullFromRecords(tag._id);
  await Tag.deleteOne({ _id: tag._id });
  await writeAudit({
    actor,
    action: 'tag.deleted',
    entityType: 'tags',
    entityId: tag._id,
    oldValue: { name: tag.name, removedFrom },
    requestId: context.requestId,
  });
  announce();
  return { removedFrom };
}

async function pullFromRecords(tagId) {
  let total = 0;
  for (const model of TAGGED_MODELS) {
    const result = await model.updateMany({ tagIds: tagId }, { $pull: { tagIds: tagId } });
    total += result.modifiedCount;
  }
  return total;
}

/**
 * Merge one tag into another: every record that had `tagId` gets `intoTagId` instead (once),
 * then `tagId` is deleted. No record loses a label.
 */
export async function mergeTags(actor, tagId, intoTagId, context = {}) {
  if (String(tagId) === String(intoTagId)) throw badRequest('Choose a different tag to merge into');
  const [tag, target] = await Promise.all([
    Tag.findById(tagId).lean(),
    Tag.findById(intoTagId).lean(),
  ]);
  if (!tag || !target) throw notFound('Tag not found');

  let moved = 0;
  for (const model of TAGGED_MODELS) {
    // $addToSet: a record that already had the target tag does not get it twice.
    const result = await model.updateMany(
      { tagIds: tag._id },
      { $addToSet: { tagIds: target._id } },
    );
    moved += result.matchedCount;
    await model.updateMany({ tagIds: tag._id }, { $pull: { tagIds: tag._id } });
  }
  await Tag.deleteOne({ _id: tag._id });
  await writeAudit({
    actor,
    action: 'tag.merged',
    entityType: 'tags',
    entityId: target._id,
    oldValue: { merged: tag.name },
    newValue: { into: target.name, records: moved },
    requestId: context.requestId,
  });
  announce();
  return { moved, into: toView(target) };
}

/**
 * Check tag ids chosen for a record: each must exist and be offered for that kind of record.
 * @param {string[]} tagIds
 * @param {'account' | 'contact' | 'opportunity'} target
 */
export async function assertUsableTags(tagIds, target) {
  const unique = [...new Set((tagIds ?? []).map(String))];
  if (unique.length === 0) return;
  const tags = await Tag.find({ _id: { $in: unique } })
    .select('appliesTo')
    .lean();
  const usable = tags.filter((tag) => !tag.appliesTo?.length || tag.appliesTo.includes(target));
  if (usable.length !== unique.length) {
    throw badRequest('Choose tags from the list', [
      { field: 'tagIds', message: 'Choose tags from the list' },
    ]);
  }
}

/** Tags by id, for showing them on records: Map(id → { id, name, color }). */
export async function loadTagsById(tagIds) {
  const unique = [...new Set(tagIds.filter(Boolean).map(String))];
  if (unique.length === 0) return new Map();
  const tags = await Tag.find({ _id: { $in: unique } }).lean();
  return new Map(tags.map((tag) => [String(tag._id), toView(tag)]));
}
