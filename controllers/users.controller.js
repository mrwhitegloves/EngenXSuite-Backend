import {
  createUser,
  getUserFormOptions,
  listUsers,
  resetUserPassword,
  updateUser,
} from '../services/users.service.js';
import { sendCreated, sendList, sendOk } from '../lib/respond.js';

// GET /api/users: the users the signed-in person may see (all for the CEO, own team for a manager).
export async function getUsers(req, res) {
  const { items, pagination } = await listUsers(req.user, req.validated.query);
  sendList(res, items, pagination);
}

// GET /api/users/form-options: account types and managers the signed-in person may choose.
export async function getFormOptions(req, res) {
  sendOk(res, await getUserFormOptions(req.user));
}

// POST /api/users: create a user account with a first password.
export async function postUser(req, res) {
  const user = await createUser(req.user, req.validated.body, { requestId: req.id });
  sendCreated(res, user);
}

// PATCH /api/users/:id: change name, phone, account type, manager, or activate / deactivate.
export async function patchUser(req, res) {
  const user = await updateUser(req.user, req.validated.params.id, req.validated.body, {
    requestId: req.id,
  });
  sendOk(res, user);
}

// POST /api/users/:id/reset-password: set a new first password for someone else.
export async function postResetPassword(req, res) {
  await resetUserPassword(req.user, req.validated.params.id, req.validated.body.password, {
    requestId: req.id,
  });
  sendOk(res, { reset: true });
}
