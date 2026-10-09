import { User } from '../models/user.model.js';
import { Role } from '../models/role.model.js';
import { env } from '../config/env.js';
import { getScope } from '../lib/can.js';
import { scopeRank } from '../constants/permissions.js';
import { conflict, forbidden, notFound, badRequest } from '../lib/errors.js';
import { revokeUserSessions } from '../lib/sessions.js';
import { diffFields, writeAudit } from '../lib/audit.js';
import { buildFilter, buildSort, runListQuery } from '../lib/queryBuilder.js';
import { toReadableUrl } from '../infra/storage.js';
import { emitToAll, emitToUser } from '../infra/realtime.js';
import { SOCKET_EVENTS } from '../constants/socketEvents.js';

// User accounts: created and managed inside the CRM by the CEO and Sales Managers
// (decisions 0009 and 0011). Every function takes the acting user first and enforces what that
// user may do.

const FEATURE = 'users';
// Sort names the list accepts (validation/users.js USER_SORTS) → database fields.
const SORT_FIELDS = {
  name: 'name',
  status: 'status',
  lastLoginAt: 'lastLoginAt',
  createdAt: 'createdAt',
};
const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const isWorkspaceEmail = (email) => email.endsWith(`@${env.WORKSPACE_DOMAIN.toLowerCase()}`);

/** The MongoDB filter for the users this actor may see. */
function visibleUsersFilter(actor) {
  const scope = getScope(actor, FEATURE, 'view');
  if (scope === 'all') return {};
  if (scope === 'team') return { $or: [{ managerId: actor._id }, { _id: actor._id }] };
  return { _id: actor._id };
}

/** May the actor perform this action on this particular user? */
function canManage(actor, action, target) {
  const scope = getScope(actor, FEATURE, action);
  if (scope === 'all') return true;
  // A manager manages the people who report to them, never themselves or other teams.
  if (scope === 'team') return sameId(target.managerId, actor._id);
  return false;
}

/**
 * Nobody may hand out more than they hold: every grant of the role must be covered by a grant
 * of the actor with the same or a wider scope. And only someone who manages ALL users may give
 * an account type that itself includes user management.
 */
function mayAssignRole(actor, role) {
  if (getScope(actor, FEATURE, 'create') === 'all') return true;
  return role.grants.every((grant) => {
    if (grant.feature === FEATURE) return false;
    const actorScope = getScope(actor, grant.feature, grant.action);
    return actorScope !== null && scopeRank(actorScope) >= scopeRank(grant.scope);
  });
}

/** How a user is sent to the browser in lists. Never includes the password. */
async function toUserView(user, rolesById) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    phone: user.phone ?? null,
    // The saved S3 address is turned into a link the browser can open (the bucket is private).
    avatarUrl: await toReadableUrl(user.avatarUrl),
    status: user.status,
    role: { id: String(user.roleId), name: rolesById.get(String(user.roleId))?.name ?? '' },
    managerId: user.managerId ? String(user.managerId) : null,
    lastLoginAt: user.lastLoginAt ?? null,
    createdAt: user.createdAt,
  };
}

async function loadRolesById() {
  const roles = await Role.find().lean();
  return new Map(roles.map((role) => [String(role._id), role]));
}

async function assertManagerExists(managerId) {
  if (managerId && !(await User.exists({ _id: managerId, status: { $ne: 'deactivated' } }))) {
    throw badRequest('The chosen manager does not exist', [{ field: 'managerId' }]);
  }
}

/** Refuse a change that would leave the CRM without any active user who can manage all users. */
async function assertAnotherAdminRemains(targetUserId, rolesById) {
  const adminRoleIds = [...rolesById.values()]
    .filter((role) =>
      role.grants.some(
        (grant) => grant.feature === FEATURE && grant.action === 'edit' && grant.scope === 'all',
      ),
    )
    .map((role) => role._id);
  const others = await User.countDocuments({
    _id: { $ne: targetUserId },
    roleId: { $in: adminRoleIds },
    status: { $ne: 'deactivated' },
  });
  if (others === 0) {
    throw conflict('This is the last administrator account. Create another one first.');
  }
}

/**
 * @param {object} actor
 * @param {{ page: number, pageSize: number, search?: string, status?: string, roleId?: string }} query
 */
export async function listUsers(actor, { page, pageSize, sort, search, status, roleId }) {
  const filter = buildFilter({
    scope: visibleUsersFilter(actor),
    equals: { status, roleId },
    search: { text: search, fields: ['name', 'email'] },
  });
  const [{ rows, pagination }, rolesById] = await Promise.all([
    runListQuery(User, { filter, sort: buildSort(sort, SORT_FIELDS, 'name'), page, pageSize }),
    loadRolesById(),
  ]);
  return {
    items: await Promise.all(rows.map((user) => toUserView(user, rolesById))),
    pagination,
  };
}

/** The account types this actor may give, and the managers they may choose (for the forms). */
export async function getUserFormOptions(actor) {
  const rolesById = await loadRolesById();
  const roles = [...rolesById.values()]
    .filter((role) => mayAssignRole(actor, role))
    .map((role) => ({ id: String(role._id), name: role.name, description: role.description }));

  const managers = await User.find({ status: { $ne: 'deactivated' } })
    .select('name')
    .sort({ name: 1 })
    .lean();
  return {
    roles,
    // Only someone who manages all users may leave "reports to" empty.
    canLeaveManagerEmpty: getScope(actor, FEATURE, 'create') === 'all',
    managers: managers.map((user) => ({ id: String(user._id), name: user.name })),
  };
}

/**
 * Create a user account with its password.
 * @param {object} actor
 * @param {{ name: string, email: string, password: string, roleId: string, managerId?: string | null,
 *           phone?: string }} data
 * @param {{ requestId?: string }} [context]
 */
export async function createUser(actor, data, context = {}) {
  const role = await Role.findById(data.roleId).lean();
  if (!role) throw badRequest('Choose an account type', [{ field: 'roleId' }]);
  if (!mayAssignRole(actor, role)) throw forbidden('You cannot create this account type.');

  // A manager's new user reports to that manager unless the manager picks someone else.
  const actorManagesAll = getScope(actor, FEATURE, 'create') === 'all';
  const managerId = data.managerId ?? (actorManagesAll ? null : actor._id);
  await assertManagerExists(managerId);

  if (await User.exists({ email: data.email })) {
    throw conflict('A user with this email already exists.', [{ field: 'email' }]);
  }

  const user = await User.create({
    name: data.name,
    email: data.email,
    phone: data.phone,
    roleId: role._id,
    managerId,
    status: 'active',
    isWorkspaceAccount: isWorkspaceEmail(data.email),
    password: data.password,
    passwordChangedAt: new Date(),
    invitedBy: actor._id,
  });

  await writeAudit({
    actor,
    action: 'user.created',
    entityType: 'users',
    entityId: user._id,
    newValue: { name: user.name, email: user.email, role: role.name, managerId },
    requestId: context.requestId,
  });
  emitToAll(SOCKET_EVENTS.usersChanged);
  return toUserView(user.toObject(), new Map([[String(role._id), role]]));
}

/**
 * Change anything about a user: name, login email, password, account type, manager, phone,
 * picture, status (decision 0011).
 * @param {object} actor
 * @param {string} userId
 * @param {object} changes  Already validated (validation/users.js updateUserBody)
 * @param {{ requestId?: string }} [context]
 */
export async function updateUser(actor, userId, changes, context = {}) {
  const user = await User.findById(userId).lean();
  const isSelf = user && sameId(user._id, actor._id);
  // 404, not 403: a manager must not learn that a user outside their team exists.
  // Someone who manages all users may also edit their own account.
  const allowed =
    user &&
    (canManage(actor, 'edit', user) || (isSelf && getScope(actor, FEATURE, 'edit') === 'all'));
  if (!allowed) throw notFound('User not found');

  const rolesById = await loadRolesById();
  const update = {};

  if (changes.name !== undefined) update.name = changes.name;
  if (changes.phone !== undefined) update.phone = changes.phone;

  if (changes.email !== undefined && changes.email !== user.email) {
    if (await User.exists({ email: changes.email, _id: { $ne: user._id } })) {
      throw conflict('A user with this email already exists.', [{ field: 'email' }]);
    }
    update.email = changes.email;
    update.isWorkspaceAccount = isWorkspaceEmail(changes.email);
  }

  if (changes.roleId !== undefined && !sameId(changes.roleId, user.roleId)) {
    const role = rolesById.get(String(changes.roleId));
    if (!role) throw badRequest('Choose an account type', [{ field: 'roleId' }]);
    if (!mayAssignRole(actor, role)) throw forbidden('You cannot give this account type.');
    await assertAnotherAdminRemains(user._id, rolesById);
    update.roleId = role._id;
  }

  if (changes.managerId !== undefined && !sameId(changes.managerId, user.managerId)) {
    if (sameId(changes.managerId, user._id)) {
      throw badRequest('A user cannot be their own manager', [{ field: 'managerId' }]);
    }
    if (changes.managerId === null && getScope(actor, FEATURE, 'edit') !== 'all') {
      throw badRequest('Choose who this user reports to', [{ field: 'managerId' }]);
    }
    await assertManagerExists(changes.managerId);
    update.managerId = changes.managerId;
  }

  if (changes.status !== undefined && changes.status !== user.status) {
    if (isSelf) throw conflict('You cannot deactivate your own account.');
    if (changes.status === 'deactivated') {
      await assertAnotherAdminRemains(user._id, rolesById);
      update.status = 'deactivated';
      update.deactivatedAt = new Date();
    } else {
      update.status = 'active';
      update.deactivatedAt = null;
    }
  }

  const { oldValue, newValue, changed } = diffFields(user, update);

  // The password is handled apart from the other fields: it must never reach the audit log.
  const current = await User.findById(user._id).select('+password').lean();
  const passwordChanged = changes.password !== undefined && changes.password !== current.password;
  if (passwordChanged) {
    update.password = changes.password;
    update.passwordChangedAt = new Date();
  }
  if (!changed && !passwordChanged) return toUserView(user, rolesById);

  const mongoUpdate = { $set: update };
  // A different email is a different Google account: forget the old Google link.
  if (update.email) mongoUpdate.$unset = { googleId: '' };
  await User.updateOne({ _id: user._id }, mongoUpdate);

  // Deactivated, or password changed by someone else: sign the user out everywhere.
  if (update.status === 'deactivated' || (passwordChanged && !isSelf)) {
    await revokeUserSessions(user._id);
  }

  if (changed) {
    await writeAudit({
      actor,
      action: update.status === 'deactivated' ? 'user.deactivated' : 'user.updated',
      entityType: 'users',
      entityId: user._id,
      oldValue,
      newValue,
      requestId: context.requestId,
    });
  }
  if (passwordChanged) {
    await writeAudit({
      actor,
      action: 'user.password_changed_by_admin',
      entityType: 'users',
      entityId: user._id,
      requestId: context.requestId,
    });
  }
  // Live update: open Users screens reload, and the changed user's own browser reloads their
  // name, picture and permissions.
  emitToAll(SOCKET_EVENTS.usersChanged);
  emitToUser(user._id, SOCKET_EVENTS.meChanged);
  return toUserView({ ...user, ...update }, rolesById);
}

/**
 * Throws 404 unless the actor may edit this user (the CEO: anyone including themselves;
 * a manager: their own team). Used by the profile picture endpoints.
 */
export async function assertCanEditUser(actor, userId) {
  const user = await User.findById(userId).select('managerId').lean();
  const isSelf = user && sameId(user._id, actor._id);
  const allowed =
    user &&
    (canManage(actor, 'edit', user) || (isSelf && getScope(actor, FEATURE, 'edit') === 'all'));
  if (!allowed) throw notFound('User not found');
}

/**
 * The password of one user, for the CEO or that user's manager to see.
 * One user at a time, the same scope check as editing them, and every view is audited.
 * @returns {Promise<{ password: string | null, available: boolean }>}
 */
export async function getUserPassword(actor, userId, context = {}) {
  const user = await User.findById(userId).select('+password managerId').lean();
  const isSelf = user && sameId(user._id, actor._id);
  const allowed =
    user &&
    (canManage(actor, 'edit', user) || (isSelf && getScope(actor, FEATURE, 'edit') === 'all'));
  if (!allowed) throw notFound('User not found');

  await writeAudit({
    actor,
    action: 'user.password_viewed',
    entityType: 'users',
    entityId: user._id,
    requestId: context.requestId,
  });
  const password = user.password ?? null;
  return { password, available: password !== null };
}
