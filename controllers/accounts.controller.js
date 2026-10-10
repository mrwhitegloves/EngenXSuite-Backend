import {
  createAccount,
  deleteAccount,
  getAccount,
  getAccountFormOptions,
  listAccounts,
  updateAccount,
} from '../services/accounts.service.js';
import { createContacts, listAccountContacts } from '../services/contacts.service.js';
import { quickAdd } from '../services/quickAdd.service.js';
import { sendCreated, sendList, sendOk } from '../lib/respond.js';

// GET /api/accounts: the accounts the signed-in person may see, with filters, sort and pages.
export async function getAccounts(req, res) {
  const { items, pagination } = await listAccounts(req.user, req.validated.query);
  sendList(res, items, pagination);
}

// GET /api/accounts/form-options: the lists the forms and filters offer.
export async function getFormOptions(req, res) {
  sendOk(res, await getAccountFormOptions(req.user));
}

// GET /api/accounts/:id: one account. 404 when it is outside the person's scope.
export async function getAccountById(req, res) {
  sendOk(res, await getAccount(req.user, req.validated.params.id));
}

// POST /api/accounts: create an account. 409 when a company with a similar name exists.
export async function postAccount(req, res) {
  sendCreated(res, await createAccount(req.user, req.validated.body, { requestId: req.id }));
}

// POST /api/accounts/quick-add: a company and its people from the one "New" form.
export async function postQuickAdd(req, res) {
  sendCreated(res, await quickAdd(req.user, req.validated.body, { requestId: req.id }));
}

// GET /api/accounts/:id/contacts: the people of one account.
export async function getAccountContacts(req, res) {
  sendOk(res, await listAccountContacts(req.user, req.validated.params.id));
}

// POST /api/accounts/:id/contacts: add one person to an account.
export async function postAccountContact(req, res) {
  const [contact] = await createContacts(req.user, req.validated.params.id, [req.validated.body], {
    requestId: req.id,
  });
  sendCreated(res, contact);
}

// PATCH /api/accounts/:id: change an account.
export async function patchAccount(req, res) {
  const account = await updateAccount(req.user, req.validated.params.id, req.validated.body, {
    requestId: req.id,
  });
  sendOk(res, account);
}

// DELETE /api/accounts/:id: soft delete.
export async function removeAccount(req, res) {
  await deleteAccount(req.user, req.validated.params.id, { requestId: req.id });
  sendOk(res, { deleted: true });
}
