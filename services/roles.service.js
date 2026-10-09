import { Role } from '../models/role.model.js';
import { User } from '../models/user.model.js';
import { ACTIONS, FEATURES, SCOPES } from '../constants/permissions.js';
import { conflict, notFound } from '../lib/errors.js';
import { writeAudit } from '../lib/audit.js';
import { emitToAll } from '../infra/realtime.js';
import { SOCKET_EVENTS } from '../constants/socketEvents.js';

// Account types (roles) and what each may do. Roles are data: this is where an administrator
// changes them (Master Prompt Sections 36 and 37). Reached only with the "settings" permission.

function toRoleView(role, userCount) {
  return {
    id: String(role._id),
    name: role.name,
    description: role.description ?? '',
    isSystem: role.isSystem,
    userCount,
    grants: role.grants.map(({ feature, action, scope }) => ({ feature, action, scope })),
  };
}

const isAdminGrant = (grant, feature) =>
  grant.feature === feature && grant.action === 'edit' && grant.scope === 'all';

/**
 * Refuse a change that would lock everybody out: after the change at least one active user must
 * still be able to edit settings (this screen) and to edit all users.
 * @param {Map<string, object[]>} grantsByRoleId  Role id → the grants it would have afterwards
 */
async function assertSomeoneCanStillAdminister(grantsByRoleId) {
  const adminRoleIds = [...grantsByRoleId.entries()]
    .filter(
      ([, grants]) =>
        grants.some((grant) => isAdminGrant(grant, 'settings')) &&
        grants.some((grant) => isAdminGrant(grant, 'users')),
    )
    .map(([roleId]) => roleId);
  const admins = await User.countDocuments({
    roleId: { $in: adminRoleIds },
    status: { $ne: 'deactivated' },
  });
  if (admins === 0) {
    throw conflict(
      'This change would leave nobody able to manage settings and users. Keep "Settings: Edit" and "Users: Edit" for all records on at least one account type that has an active user.',
    );
  }
}

/** All account types with their permissions and how many users have each. */
export async function listRoles() {
  const [roles, counts] = await Promise.all([
    Role.find().sort({ isSystem: -1, name: 1 }).lean(),
    User.aggregate([
      { $match: { status: { $ne: 'deactivated' } } },
      { $group: { _id: '$roleId', count: { $sum: 1 } } },
    ]),
  ]);
  const countByRole = new Map(counts.map((row) => [String(row._id), row.count]));
  return roles.map((role) => toRoleView(role, countByRole.get(String(role._id)) ?? 0));
}

/** What can be granted: the screen builds its table from this, so it never drifts from the code. */
export function getPermissionCatalogue() {
  return { features: FEATURES, actions: ACTIONS, scopes: SCOPES };
}

/** @param {object} actor @param {{ name: string, description?: string, grants: object[] }} data */
export async function createRole(actor, data, context = {}) {
  if (await Role.exists({ name: data.name })) {
    throw conflict('An account type with this name already exists.', [{ field: 'name' }]);
  }
  const role = await Role.create({ ...data, isSystem: false });
  await writeAudit({
    actor,
    action: 'role.created',
    entityType: 'roles',
    entityId: role._id,
    newValue: { name: role.name, grants: role.grants.length },
    requestId: context.requestId,
  });
  emitToAll(SOCKET_EVENTS.permissionsChanged);
  return toRoleView(role.toObject(), 0);
}

/**
 * Change an account type's name, description or permissions. The change applies to every user
 * of that type on their next request.
 */
export async function updateRole(actor, roleId, changes, context = {}) {
  const role = await Role.findById(roleId).lean();
  if (!role) throw notFound('Account type not found');

  const update = {};
  if (changes.description !== undefined) update.description = changes.description;
  if (changes.name !== undefined && changes.name !== role.name) {
    // The three built-in types are referred to by name in the seed and the docs.
    if (role.isSystem) throw conflict('A built-in account type cannot be renamed.');
    if (await Role.exists({ name: changes.name, _id: { $ne: role._id } })) {
      throw conflict('An account type with this name already exists.', [{ field: 'name' }]);
    }
    update.name = changes.name;
  }

  if (changes.grants !== undefined) {
    const allRoles = await Role.find().select('grants').lean();
    const grantsByRoleId = new Map(allRoles.map((item) => [String(item._id), item.grants]));
    grantsByRoleId.set(String(role._id), changes.grants);
    await assertSomeoneCanStillAdminister(grantsByRoleId);
    update.grants = changes.grants;
  }

  await Role.updateOne({ _id: role._id }, { $set: update });
  await writeAudit({
    actor,
    action: 'role.updated',
    entityType: 'roles',
    entityId: role._id,
    oldValue: { name: role.name, description: role.description, grants: role.grants },
    newValue: update,
    requestId: context.requestId,
  });
  // Live update: every signed-in browser reloads its own permissions and menu.
  emitToAll(SOCKET_EVENTS.permissionsChanged);

  const updated = await Role.findById(role._id).lean();
  const userCount = await User.countDocuments({
    roleId: role._id,
    status: { $ne: 'deactivated' },
  });
  return toRoleView(updated, userCount);
}

/** Delete an account type that is not built in and that no user has. */
export async function deleteRole(actor, roleId, context = {}) {
  const role = await Role.findById(roleId).lean();
  if (!role) throw notFound('Account type not found');
  if (role.isSystem) throw conflict('A built-in account type cannot be deleted.');
  if (await User.exists({ roleId: role._id })) {
    throw conflict('Users still have this account type. Give them another one first.');
  }
  await Role.deleteOne({ _id: role._id });
  await writeAudit({
    actor,
    action: 'role.deleted',
    entityType: 'roles',
    entityId: role._id,
    oldValue: { name: role.name },
    requestId: context.requestId,
  });
  emitToAll(SOCKET_EVENTS.permissionsChanged);
}
