import { Router } from 'express';
import {
  getPlantMachines,
  patchContact,
  patchMachine,
  patchPlant,
  postPlantMachine,
  removeContact,
  removeMachine,
  removePlant,
} from '../controllers/plants.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { idParams } from '../validation/common.js';
import { updateContactBody } from '../validation/contacts.js';
import { createMachineBody, updateMachineBody, updatePlantBody } from '../validation/plants.js';

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
