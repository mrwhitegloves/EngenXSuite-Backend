import { Contact } from '../models/contact.model.js';
import { Machine } from '../models/machine.model.js';
import { PLANT_HEAD_FIELDS, Plant } from '../models/plant.model.js';
import { PlantUnit } from '../models/plantUnit.model.js';
import { SOCKET_EVENTS } from '../constants/socketEvents.js';
import { emitToAll } from '../infra/realtime.js';
import { writeAudit } from '../lib/audit.js';
import { can } from '../lib/can.js';
import { planChanges, toUpdate } from '../lib/changes.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { containsPattern } from '../lib/queryBuilder.js';
import { loadAccountForAction } from './accounts.service.js';

// Plants and their machines. Both are reached through their account: whoever may not see the
// account cannot see its plants or machines (404). What a person may DO with them is the
// "plants" permission (machines have no permission of their own: they are part of a plant).

const FEATURE = 'plants';
const NOT_DELETED = { deletedAt: null };

function assertAllowed(actor, action) {
  if (!can(actor, action, { feature: FEATURE })) {
    throw forbidden('You do not have permission to do this with plants.');
  }
}

/** Without null, undefined and empty lists; an emptied address disappears altogether. */
function given(data) {
  const result = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) result[key] = value;
    } else if (typeof value === 'object') {
      const inner = given(value);
      if (Object.keys(inner).length > 0) result[key] = inner;
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ── Plants ──────────────────────────────────────────────────────────────────────────────────

async function toPlantViews(plants) {
  const contactIds = plants.flatMap((plant) => [
    ...PLANT_HEAD_FIELDS.map((field) => plant[field]),
    ...(plant.itOtContactIds ?? []),
  ]);
  const unique = [...new Set(contactIds.filter(Boolean).map(String))];
  const [contacts, machineCounts] = await Promise.all([
    unique.length
      ? Contact.find({ _id: { $in: unique }, ...NOT_DELETED })
          .select('name designation')
          .lean()
      : [],
    Machine.aggregate([
      { $match: { plantId: { $in: plants.map((plant) => plant._id) }, ...NOT_DELETED } },
      { $group: { _id: '$plantId', rows: { $sum: 1 }, machines: { $sum: '$quantity' } } },
    ]),
  ]);
  const contactById = new Map(contacts.map((contact) => [String(contact._id), contact]));
  const countById = new Map(machineCounts.map((count) => [String(count._id), count]));
  const person = (id) => {
    const contact = id && contactById.get(String(id));
    return contact
      ? { id: String(contact._id), name: contact.name, designation: contact.designation ?? null }
      : null;
  };

  return plants.map((plant) => ({
    id: String(plant._id),
    accountId: String(plant.accountId),
    name: plant.name,
    location: plant.location ?? null,
    process: plant.process ?? null,
    plantType: plant.plantType ?? null,
    size: plant.size ?? null,
    productionCapacity: plant.productionCapacity ?? null,
    plantHead: person(plant.plantHeadId),
    maintenanceHead: person(plant.maintenanceHeadId),
    productionHead: person(plant.productionHeadId),
    digitalHead: person(plant.digitalHeadId),
    itOtContacts: (plant.itOtContactIds ?? []).map(person).filter(Boolean),
    existingAutomation: plant.existingAutomation ?? null,
    plcScada: plant.plcScada ?? null,
    mesErp: plant.mesErp ?? null,
    digitalMaturity: plant.digitalMaturity ?? null,
    // Rows in the machine list, and machines in all (a row can stand for many).
    machineRows: countById.get(String(plant._id))?.rows ?? 0,
    machineCount: countById.get(String(plant._id))?.machines ?? 0,
    createdAt: plant.createdAt,
  }));
}

/** The people named on a plant must be contacts of the same company. */
async function assertContactsOfAccount(accountId, data) {
  const ids = [
    ...PLANT_HEAD_FIELDS.map((field) => data[field]),
    ...(data.itOtContactIds ?? []),
  ].filter(Boolean);
  const unique = [...new Set(ids.map(String))];
  if (unique.length === 0) return;
  const found = await Contact.countDocuments({ _id: { $in: unique }, accountId, ...NOT_DELETED });
  if (found !== unique.length) {
    throw badRequest('Choose people from this company’s contacts', [
      { field: 'plantHeadId', message: 'Choose people from this company’s contacts' },
    ]);
  }
}

/** Two plants of one company cannot have the same name (any letter case). */
async function assertPlantNameIsFree(accountId, name, exceptPlantId) {
  const filter = {
    accountId,
    ...NOT_DELETED,
    name: new RegExp(`^${containsPattern(name).source}$`, 'i'),
  };
  if (exceptPlantId) filter._id = { $ne: exceptPlantId };
  if (await Plant.exists(filter)) {
    throw conflict('This company already has a plant with this name.', [{ field: 'name' }]);
  }
}

async function loadPlant(actor, plantId) {
  const plant = await Plant.findOne({ _id: plantId, ...NOT_DELETED }).lean();
  if (!plant) throw notFound('Plant not found');
  await loadAccountForAction(actor, plant.accountId, 'view').catch(() => {
    throw notFound('Plant not found');
  });
  return plant;
}

/** The plants of one account, by name. */
export async function listPlants(actor, accountId) {
  const account = await loadAccountForAction(actor, accountId, 'view');
  const plants = await Plant.find({ accountId: account._id, ...NOT_DELETED })
    .sort({ name: 1, _id: 1 })
    .lean();
  return toPlantViews(plants);
}

/** @param {object} data  Already validated (validation/plants.js createPlantBody) */
export async function createPlant(actor, accountId, data, context = {}) {
  const account = await loadAccountForAction(actor, accountId, 'view');
  assertAllowed(actor, 'create');
  await assertPlantNameIsFree(account._id, data.name);
  await assertContactsOfAccount(account._id, data);

  const plant = await Plant.create({
    ...given(data),
    accountId: account._id,
    createdBy: actor._id,
  });
  await writeAudit({
    actor,
    action: 'plant.created',
    entityType: 'plants',
    entityId: plant._id,
    newValue: { name: plant.name, accountId: String(account._id) },
    requestId: context.requestId,
  });
  emitToAll(SOCKET_EVENTS.plantsChanged);
  return (await toPlantViews([plant.toObject()]))[0];
}

/** @param {object} changes  Already validated (validation/plants.js updatePlantBody) */
export async function updatePlant(actor, plantId, changes, context = {}) {
  const plant = await loadPlant(actor, plantId);
  assertAllowed(actor, 'edit');

  const plan = planChanges(plant, changes, { nested: ['location'] });
  if (plan.fields.includes('name')) {
    await assertPlantNameIsFree(plant.accountId, plan.newValue.name, plant._id);
  }
  await assertContactsOfAccount(plant.accountId, plan.set);

  const update = toUpdate(plan);
  if (update) {
    await Plant.updateOne({ _id: plant._id }, update, { runValidators: true });
    await writeAudit({
      actor,
      action: 'plant.updated',
      entityType: 'plants',
      entityId: plant._id,
      oldValue: plan.oldValue,
      newValue: plan.newValue,
      requestId: context.requestId,
    });
    emitToAll(SOCKET_EVENTS.plantsChanged);
  }
  return (await toPlantViews([await Plant.findById(plant._id).lean()]))[0];
}

/** Soft delete a plant; its machines are hidden with it. */
export async function deletePlant(actor, plantId, context = {}) {
  const plant = await loadPlant(actor, plantId);
  assertAllowed(actor, 'delete');

  const deletion = { deletedAt: new Date(), deletedBy: actor._id };
  await Plant.updateOne({ _id: plant._id }, { $set: deletion });
  await Machine.updateMany({ plantId: plant._id, ...NOT_DELETED }, { $set: deletion });
  await writeAudit({
    actor,
    action: 'plant.deleted',
    entityType: 'plants',
    entityId: plant._id,
    oldValue: { name: plant.name, accountId: String(plant.accountId) },
    requestId: context.requestId,
  });
  emitToAll(SOCKET_EVENTS.plantsChanged);
}

// ── Machines ────────────────────────────────────────────────────────────────────────────────

function toMachineView(machine) {
  return {
    id: String(machine._id),
    plantId: String(machine.plantId),
    name: machine.name,
    // The department or line it stands in (null: directly in the plant).
    unitId: machine.unitId ? String(machine.unitId) : null,
    quantity: machine.quantity,
    machineType: machine.machineType ?? null,
    manufacturer: machine.manufacturer ?? null,
    model: machine.model ?? null,
    controller: machine.controller ?? null,
    plc: machine.plc ?? null,
    protocol: machine.protocol ?? null,
    yearInstalled: machine.yearInstalled ?? null,
    // Worked out, never stored: it would be wrong again next year.
    ageYears: machine.yearInstalled
      ? Math.max(0, new Date().getFullYear() - machine.yearInstalled)
      : null,
    criticality: machine.criticality ?? null,
    condition: machine.condition ?? null,
    dataAvailability: machine.dataAvailability ?? null,
    existingSensors: machine.existingSensors ?? [],
    createdAt: machine.createdAt,
  };
}

async function loadMachine(actor, machineId) {
  const machine = await Machine.findOne({ _id: machineId, ...NOT_DELETED }).lean();
  if (!machine) throw notFound('Machine not found');
  // The plant check also covers the account: outside the actor's scope means "not found".
  await loadPlant(actor, machine.plantId).catch(() => {
    throw notFound('Machine not found');
  });
  return machine;
}

/** The machines of one plant, by name. */
export async function listMachines(actor, plantId) {
  const plant = await loadPlant(actor, plantId);
  const machines = await Machine.find({ plantId: plant._id, ...NOT_DELETED })
    .sort({ name: 1, _id: 1 })
    .lean();
  return machines.map(toMachineView);
}

/** @param {object} data  Already validated (validation/plants.js createMachineBody) */
export async function createMachine(actor, plantId, data, context = {}) {
  const plant = await loadPlant(actor, plantId);
  assertAllowed(actor, 'create');
  await assertUnitOfPlant(plant._id, data.unitId);
  const machine = await Machine.create({
    ...given(data),
    plantId: plant._id,
    createdBy: actor._id,
  });
  await writeAudit({
    actor,
    action: 'machine.created',
    entityType: 'machines',
    entityId: machine._id,
    newValue: { name: machine.name, quantity: machine.quantity, plantId: String(plant._id) },
    requestId: context.requestId,
  });
  emitToAll(SOCKET_EVENTS.plantsChanged);
  return toMachineView(machine.toObject());
}

/** @param {object} changes  Already validated (validation/plants.js updateMachineBody) */
export async function updateMachine(actor, machineId, changes, context = {}) {
  const machine = await loadMachine(actor, machineId);
  assertAllowed(actor, 'edit');
  if (changes.quantity === null) throw badRequest('A machine row has a quantity of at least 1');

  const plan = planChanges(machine, changes);
  if (plan.fields.includes('unitId')) await assertUnitOfPlant(machine.plantId, changes.unitId);
  const update = toUpdate(plan);
  if (update) {
    await Machine.updateOne({ _id: machine._id }, update, { runValidators: true });
    await writeAudit({
      actor,
      action: 'machine.updated',
      entityType: 'machines',
      entityId: machine._id,
      oldValue: plan.oldValue,
      newValue: plan.newValue,
      requestId: context.requestId,
    });
    emitToAll(SOCKET_EVENTS.plantsChanged);
  }
  return toMachineView(await Machine.findById(machine._id).lean());
}

export async function deleteMachine(actor, machineId, context = {}) {
  const machine = await loadMachine(actor, machineId);
  assertAllowed(actor, 'delete');
  await Machine.updateOne(
    { _id: machine._id },
    { $set: { deletedAt: new Date(), deletedBy: actor._id } },
  );
  await writeAudit({
    actor,
    action: 'machine.deleted',
    entityType: 'machines',
    entityId: machine._id,
    oldValue: { name: machine.name, plantId: String(machine.plantId) },
    requestId: context.requestId,
  });
  emitToAll(SOCKET_EVENTS.plantsChanged);
}

// ── Departments and production lines ────────────────────────────────────────────────────────
// Plant → Department → Production line → Machine. A line may sit under a department or
// directly under the plant. They only group things, so they are removed for good when deleted
// (the machines and lines that pointed at them simply stop pointing).

function toUnitView(unit) {
  return {
    id: String(unit._id),
    plantId: String(unit.plantId),
    type: unit.type,
    name: unit.name,
    parentId: unit.parentId ? String(unit.parentId) : null,
  };
}

async function loadUnit(actor, unitId) {
  const unit = await PlantUnit.findById(unitId).lean();
  if (!unit) throw notFound('Not found');
  await loadPlant(actor, unit.plantId).catch(() => {
    throw notFound('Not found');
  });
  return unit;
}

/** Two departments (or two lines) of one plant cannot have the same name. */
async function assertUnitNameIsFree(plantId, type, name, exceptUnitId) {
  const filter = { plantId, type, name: new RegExp(`^${containsPattern(name).source}$`, 'i') };
  if (exceptUnitId) filter._id = { $ne: exceptUnitId };
  if (await PlantUnit.exists(filter)) {
    throw conflict(`This plant already has a ${type} with this name.`, [{ field: 'name' }]);
  }
}

/** A line's parent must be a department of the same plant; a department has no parent. */
async function assertUsableParentUnit(plantId, type, parentId) {
  if (!parentId) return;
  const fail = (message) => badRequest(message, [{ field: 'parentId', message }]);
  if (type === 'department') throw fail('A department sits directly under the plant.');
  const parent = await PlantUnit.findOne({ _id: parentId, plantId, type: 'department' }).lean();
  if (!parent) throw fail('Choose a department of this plant.');
}

/** A machine's place must be a department or line of its own plant. */
async function assertUnitOfPlant(plantId, unitId) {
  if (!unitId) return;
  if (!(await PlantUnit.exists({ _id: unitId, plantId }))) {
    throw badRequest('Choose a department or line of this plant', [{ field: 'unitId' }]);
  }
}

/** The departments and lines of one plant: departments first, then lines, each by name. */
export async function listUnits(actor, plantId) {
  const plant = await loadPlant(actor, plantId);
  const units = await PlantUnit.find({ plantId: plant._id }).sort({ type: 1, name: 1 }).lean();
  return units.map(toUnitView);
}

/** @param {{ type: 'department' | 'line', name: string, parentId?: string | null }} data */
export async function createUnit(actor, plantId, data, context = {}) {
  const plant = await loadPlant(actor, plantId);
  assertAllowed(actor, 'create');
  await assertUnitNameIsFree(plant._id, data.type, data.name);
  await assertUsableParentUnit(plant._id, data.type, data.parentId);

  const unit = await PlantUnit.create({
    plantId: plant._id,
    type: data.type,
    name: data.name,
    ...(data.parentId ? { parentId: data.parentId } : {}),
    createdBy: actor._id,
  });
  await writeAudit({
    actor,
    action: 'plant_unit.created',
    entityType: 'plant_units',
    entityId: unit._id,
    newValue: { type: unit.type, name: unit.name, plantId: String(plant._id) },
    requestId: context.requestId,
  });
  emitToAll(SOCKET_EVENTS.plantsChanged);
  return toUnitView(unit.toObject());
}

/** Rename, or move a line under another department (null: directly under the plant). */
export async function updateUnit(actor, unitId, changes, context = {}) {
  const unit = await loadUnit(actor, unitId);
  assertAllowed(actor, 'edit');

  const plan = planChanges(unit, changes);
  if (plan.fields.includes('name')) {
    await assertUnitNameIsFree(unit.plantId, unit.type, plan.newValue.name, unit._id);
  }
  if (plan.fields.includes('parentId')) {
    await assertUsableParentUnit(unit.plantId, unit.type, plan.newValue.parentId);
  }
  const update = toUpdate(plan);
  if (update) {
    await PlantUnit.updateOne({ _id: unit._id }, update, { runValidators: true });
    await writeAudit({
      actor,
      action: 'plant_unit.updated',
      entityType: 'plant_units',
      entityId: unit._id,
      oldValue: plan.oldValue,
      newValue: plan.newValue,
      requestId: context.requestId,
    });
    emitToAll(SOCKET_EVENTS.plantsChanged);
  }
  return toUnitView(await PlantUnit.findById(unit._id).lean());
}

/** Remove a department or line. Its machines and lines stay; they just stop pointing at it. */
export async function deleteUnit(actor, unitId, context = {}) {
  const unit = await loadUnit(actor, unitId);
  assertAllowed(actor, 'delete');

  await Machine.updateMany({ unitId: unit._id }, { $unset: { unitId: '' } });
  await PlantUnit.updateMany({ parentId: unit._id }, { $unset: { parentId: '' } });
  await PlantUnit.deleteOne({ _id: unit._id });
  await writeAudit({
    actor,
    action: 'plant_unit.deleted',
    entityType: 'plant_units',
    entityId: unit._id,
    oldValue: { type: unit.type, name: unit.name, plantId: String(unit.plantId) },
    requestId: context.requestId,
  });
  emitToAll(SOCKET_EVENTS.plantsChanged);
}
