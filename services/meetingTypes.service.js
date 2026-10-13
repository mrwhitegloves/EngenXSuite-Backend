import { writeAudit } from '../lib/audit.js';
import { conflict, notFound } from '../lib/errors.js';
import { Meeting } from '../models/meeting.model.js';
import { MeetingType } from '../models/meetingType.model.js';

// The kinds of meeting, managed in Settings → Meeting types. A meeting keeps the id of its
// kind and a copy of how it is held (`mode`), so history stays right when a kind changes.

// The list a new installation starts with (made the first time the list is asked for).
const STARTING_TYPES = [
  { name: 'Online meeting', mode: 'online', durationMinutes: 30, isBookable: true, order: 1 },
  { name: 'Meeting in person', mode: 'physical', durationMinutes: 60, order: 2 },
  { name: 'Plant visit', mode: 'plant_visit', durationMinutes: 120, order: 3 },
];

const toView = (type) => ({
  id: String(type._id),
  name: type.name,
  mode: type.mode,
  durationMinutes: type.durationMinutes,
  isBookable: type.isBookable,
  isActive: type.isActive,
  order: type.order,
});

async function ensureStartingTypes() {
  if (await MeetingType.exists({})) return;
  // Two requests at the same moment: the unique name lets only one set in.
  await MeetingType.insertMany(STARTING_TYPES, { ordered: false }).catch(() => {});
}

/** Every kind of meeting, in the order of the list. */
export async function listMeetingTypes() {
  await ensureStartingTypes();
  return (await MeetingType.find().sort({ order: 1, name: 1 }).lean()).map(toView);
}

async function saved(write) {
  try {
    return await write();
  } catch (error) {
    if (error?.code === 11000) throw conflict('A meeting type with this name exists already.');
    throw error;
  }
}

/** @param {{ name: string, mode: string, durationMinutes: number, isBookable?: boolean }} data */
export async function createMeetingType(actor, data, context = {}) {
  const last = await MeetingType.findOne().sort({ order: -1 }).select('order').lean();
  const type = await saved(() => MeetingType.create({ ...data, order: (last?.order ?? 0) + 1 }));
  await writeAudit({
    actor,
    action: 'meeting_type.created',
    entityType: 'meeting_types',
    entityId: type._id,
    newValue: data,
    requestId: context.requestId,
  });
  return toView(type);
}

export async function updateMeetingType(actor, typeId, changes, context = {}) {
  const before = await MeetingType.findById(typeId).lean();
  if (!before) throw notFound('Meeting type not found');
  const after = await saved(() =>
    MeetingType.findByIdAndUpdate(typeId, { $set: changes }, { returnDocument: 'after' }).lean(),
  );
  await writeAudit({
    actor,
    action: 'meeting_type.updated',
    entityType: 'meeting_types',
    entityId: after._id,
    oldValue: Object.fromEntries(Object.keys(changes).map((key) => [key, before[key]])),
    newValue: changes,
    requestId: context.requestId,
  });
  return toView(after);
}

/** A kind that a meeting uses cannot be deleted: switch it off instead. */
export async function deleteMeetingType(actor, typeId, context = {}) {
  const type = await MeetingType.findById(typeId).lean();
  if (!type) throw notFound('Meeting type not found');
  if (await Meeting.exists({ typeId: type._id })) {
    throw conflict('Meetings use this type. Switch it off instead of deleting it.');
  }
  await MeetingType.deleteOne({ _id: type._id });
  await writeAudit({
    actor,
    action: 'meeting_type.deleted',
    entityType: 'meeting_types',
    entityId: type._id,
    oldValue: { name: type.name },
    requestId: context.requestId,
  });
  return { deleted: true };
}
