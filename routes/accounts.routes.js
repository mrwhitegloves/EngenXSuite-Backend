import { Router } from 'express';
import {
  getAccountById,
  getAccounts,
  getFormOptions,
  patchAccount,
  postAccount,
  removeAccount,
} from '../controllers/accounts.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { createAccountBody, listAccountsQuery, updateAccountBody } from '../validation/accounts.js';
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
router.get('/:id', authorize('accounts', 'view'), validate({ params: idParams }), getAccountById);
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
