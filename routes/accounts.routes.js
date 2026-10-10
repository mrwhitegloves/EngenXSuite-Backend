import { Router } from 'express';
import {
  getAccountById,
  getAccountContacts,
  getAccounts,
  getFormOptions,
  patchAccount,
  postAccount,
  postAccountContact,
  postQuickAdd,
  removeAccount,
} from '../controllers/accounts.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import {
  createAccountBody,
  listAccountsQuery,
  quickAddBody,
  updateAccountBody,
} from '../validation/accounts.js';
import { createContactBody } from '../validation/contacts.js';
import { idParams } from '../validation/common.js';

// Accounts (customer companies). authorize() answers "may this person do this at all";
// whether THIS account is inside their scope is checked in the service (404 when it is not).
const router = Router();

router.use(requireAuth);

router.get('/', authorize('accounts', 'view'), validate({ query: listAccountsQuery }), getAccounts);
router.get('/form-options', authorize('accounts', 'view'), getFormOptions);
router.post(
  '/',
  authorize('accounts', 'create'),
  validate({ body: createAccountBody }),
  postAccount,
);
// Before the /:id routes, so "quick-add" is not read as an id.
router.post(
  '/quick-add',
  authorize('accounts', 'create'),
  validate({ body: quickAddBody }),
  postQuickAdd,
);
router.get('/:id', authorize('accounts', 'view'), validate({ params: idParams }), getAccountById);
// The people of an account. Seeing the account is checked in the service (404 when not).
router.get(
  '/:id/contacts',
  authorize('contacts', 'view'),
  validate({ params: idParams }),
  getAccountContacts,
);
router.post(
  '/:id/contacts',
  authorize('contacts', 'create'),
  validate({ params: idParams, body: createContactBody }),
  postAccountContact,
);
router.patch(
  '/:id',
  authorize('accounts', 'edit'),
  validate({ params: idParams, body: updateAccountBody }),
  patchAccount,
);
router.delete(
  '/:id',
  authorize('accounts', 'delete'),
  validate({ params: idParams }),
  removeAccount,
);

export default router;
