import { Router } from 'express';
import {
  getPlantMachines,
  getPlantUnits,
  patchContact,
  patchMachine,
  patchPlant,
  patchUnit,
  postPlantMachine,
  postPlantUnit,
  removeContact,
  removeMachine,
  removePlant,
  removeUnit,
} from '../controllers/plants.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { idParams } from '../validation/common.js';
import { updateContactBody } from '../validation/contacts.js';
import {
  createMachineBody,
  createUnitBody,
  updateMachineBody,
  updatePlantBody,
  updateUnitBody,
} from '../validation/plants.js';

// Changing and deleting the records that hang under an account, by their own id.
// (Listing and adding them is under the account: routes/accounts.routes.js.)
// authorize() answers "may this person do this at all"; whether the record's ACCOUNT is inside
// their scope is checked in the service, which answers 404 when it is not.
// Machines are part of a plant and use the "plants" permission.

function childRoutes() {
  const router = Router();
  router.use(requireAuth);
  return router;
}

export const contactsRouter = childRoutes();
contactsRouter.patch(
  '/:id',
  authorize('contacts', 'edit'),
  validate({ params: idParams, body: updateContactBody }),
  patchContact,
);
contactsRouter.delete(
  '/:id',
  authorize('contacts', 'delete'),
  validate({ params: idParams }),
  removeContact,
);

export const plantsRouter = childRoutes();
plantsRouter.patch(
  '/:id',
  authorize('plants', 'edit'),
  validate({ params: idParams, body: updatePlantBody }),
  patchPlant,
);
plantsRouter.delete(
  '/:id',
  authorize('plants', 'delete'),
  validate({ params: idParams }),
  removePlant,
);
plantsRouter.get(
  '/:id/machines',
  authorize('plants', 'view'),
  validate({ params: idParams }),
  getPlantMachines,
);
plantsRouter.post(
  '/:id/machines',
  authorize('plants', 'create'),
  validate({ params: idParams, body: createMachineBody }),
  postPlantMachine,
);

plantsRouter.get(
  '/:id/units',
  authorize('plants', 'view'),
  validate({ params: idParams }),
  getPlantUnits,
);
plantsRouter.post(
  '/:id/units',
  authorize('plants', 'create'),
  validate({ params: idParams, body: createUnitBody }),
  postPlantUnit,
);

// Departments and production lines, by their own id.
export const plantUnitsRouter = childRoutes();
plantUnitsRouter.patch(
  '/:id',
  authorize('plants', 'edit'),
  validate({ params: idParams, body: updateUnitBody }),
  patchUnit,
);
plantUnitsRouter.delete(
  '/:id',
  authorize('plants', 'delete'),
  validate({ params: idParams }),
  removeUnit,
);

export const machinesRouter = childRoutes();
machinesRouter.patch(
  '/:id',
  authorize('plants', 'edit'),
  validate({ params: idParams, body: updateMachineBody }),
  patchMachine,
);
machinesRouter.delete(
  '/:id',
  authorize('plants', 'delete'),
  validate({ params: idParams }),
  removeMachine,
);
