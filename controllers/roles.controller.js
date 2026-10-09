import {
  createRole,
  deleteRole,
  getPermissionCatalogue,
  listRoles,
  updateRole,
} from '../services/roles.service.js';
import { sendCreated, sendOk } from '../lib/respond.js';

// GET /api/roles: every account type with its permissions, plus the list of what can be granted.
export async function getRoles(req, res) {
  sendOk(res, { roles: await listRoles(), catalogue: getPermissionCatalogue() });
}

// POST /api/roles: a new account type.
export async function postRole(req, res) {
  sendCreated(res, await createRole(req.user, req.validated.body, { requestId: req.id }));
}

// PATCH /api/roles/:id: change name, description or permissions.
export async function patchRole(req, res) {
  const role = await updateRole(req.user, req.validated.params.id, req.validated.body, {
    requestId: req.id,
  });
  sendOk(res, role);
}

// DELETE /api/roles/:id: only for a type that is not built in and has no users.
export async function removeRole(req, res) {
  await deleteRole(req.user, req.validated.params.id, { requestId: req.id });
  sendOk(res, { deleted: true });
}
