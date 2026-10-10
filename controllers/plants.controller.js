import { deleteContact, updateContact } from '../services/contacts.service.js';
import {
  createMachine,
  createPlant,
  createUnit,
  deleteMachine,
  deletePlant,
  deleteUnit,
  listMachines,
  listPlants,
  listUnits,
  updateMachine,
  updatePlant,
  updateUnit,
} from '../services/plants.service.js';
import { sendCreated, sendOk } from '../lib/respond.js';

// The records that hang under an account: contacts, plants and machines.
// Each function: read the validated request, call one service function, respond.

const context = (req) => ({ requestId: req.id });

// PATCH /api/contacts/:id
export async function patchContact(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await updateContact(req.user, params.id, body, context(req)));
}

// DELETE /api/contacts/:id
export async function removeContact(req, res) {
  await deleteContact(req.user, req.validated.params.id, context(req));
  sendOk(res, { deleted: true });
}

// GET /api/accounts/:id/plants
export async function getAccountPlants(req, res) {
  sendOk(res, await listPlants(req.user, req.validated.params.id));
}

// POST /api/accounts/:id/plants
export async function postAccountPlant(req, res) {
  const { params, body } = req.validated;
  sendCreated(res, await createPlant(req.user, params.id, body, context(req)));
}

// PATCH /api/plants/:id
export async function patchPlant(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await updatePlant(req.user, params.id, body, context(req)));
}

// DELETE /api/plants/:id
export async function removePlant(req, res) {
  await deletePlant(req.user, req.validated.params.id, context(req));
  sendOk(res, { deleted: true });
}

// GET /api/plants/:id/machines
export async function getPlantMachines(req, res) {
  sendOk(res, await listMachines(req.user, req.validated.params.id));
}

// POST /api/plants/:id/machines
export async function postPlantMachine(req, res) {
  const { params, body } = req.validated;
  sendCreated(res, await createMachine(req.user, params.id, body, context(req)));
}

// GET /api/plants/:id/units
export async function getPlantUnits(req, res) {
  sendOk(res, await listUnits(req.user, req.validated.params.id));
}

// POST /api/plants/:id/units
export async function postPlantUnit(req, res) {
  const { params, body } = req.validated;
  sendCreated(res, await createUnit(req.user, params.id, body, context(req)));
}

// PATCH /api/plant-units/:id
export async function patchUnit(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await updateUnit(req.user, params.id, body, context(req)));
}

// DELETE /api/plant-units/:id
export async function removeUnit(req, res) {
  await deleteUnit(req.user, req.validated.params.id, context(req));
  sendOk(res, { deleted: true });
}

// PATCH /api/machines/:id
export async function patchMachine(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await updateMachine(req.user, params.id, body, context(req)));
}

// DELETE /api/machines/:id
export async function removeMachine(req, res) {
  await deleteMachine(req.user, req.validated.params.id, context(req));
  sendOk(res, { deleted: true });
}
