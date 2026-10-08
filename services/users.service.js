import { User } from '../models/user.model.js';
import { Role } from '../models/role.model.js';
import { getScope } from '../lib/can.js';
import { scopeRank } from '../constants/permissions.js';
import { conflict, forbidden, notFound, badRequest } from '../lib/errors.js';
import { hashPassword } from '../infra/password.js';
import { revokeUserSessions } from '../lib/sessions.js';
import { diffFields, writeAudit } from '../lib/audit.js';

// User accounts: created and managed inside the CRM by the CEO and Sales Managers (decision 0009).
// Every function takes the acting user first and enforces what that user may do.

const FEATURE = 'users';
const sameId = (a, b) => a != null && b != null && String(a) === String(b);

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

/** How a user is sent to the browser. Never includes the password hash. */
function toUserView(user, rolesById) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    phone: user.phone ?? null,
    status: user.status,
    role: { id: String(user.roleId), name: rolesById.get(String(user.roleId))?.name ?? '' },
    managerId: user.managerId ? String(user.managerId) : null,
    mustChangePassword: user.mustChangePassword === true,
    lastLoginAt: user.lastLoginAt ?? null,
    createdAt: user.createdAt,
  };
}

async function loadRolesById() {
  const roles = await Role.find().lean();
  return new Map(roles.map((role) => [String(role._id), role]));
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
export async function listUsers(actor, { page, pageSize, search, status, roleId }) {
  const filters = [visibleUsersFilter(actor)];
  if (status) filters.push({ status });
  if (roleId) filters.push({ roleId });
  if (search) {
    // Escape the text so it is matched literally, not run as a pattern.
    const pattern = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filters.push({ $or: [{ name: pattern }, { email: pattern }] });
  }
  const filter = { $and: filters };

  const [users, total, rolesById] = await Promise.all([
    User.find(filter)
      .sort({ name: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    User.countDocuments(filter),
    loadRolesById(),
  ]);
  return {
    items: users.map((user) => toUserView(user, rolesById)),
    pagination: { page, pageSize, total },
  };
}

/** The account types this actor may give, and the managers they may choose (for the form). */
export async function getUserFormOptions(actor) {
  const rolesById = await loadRolesById();
  const roles = [...rolesById.values()]
    .filter((role) => mayAssignRole(actor, role))
    .map((role) => ({ id: String(role._id), name: role.name, description: role.description }));

  const canChooseManager = getScope(actor, FEATURE, 'create') === 'all';
  const managers = canChooseManager
    ? await User.find({ status: { $ne: 'deactivated' } })
        .select('name email')
        .sort({ name: 1 })
        .lean()
    : [];
  return {
    roles,
    canChooseManager,
    managers: managers.map((user) => ({ id: String(user._id), name: user.name })),
  };
}

/**
 * Create a user account with a first password. The new user must choose their own password
 * at their first sign-in.
 * @param {object} actor
 * @param {{ name: string, email: string, password: string, roleId: string, managerId?: string | null, phone?: string }} data
 * @param {{ requestId?: string }} [context]
 */
export async function createUser(actor, data, context = {}) {
  const role = await Role.findById(data.roleId).lean();
  if (!role) throw badRequest('Choose an account type', [{ field: 'roleId' }]);
  if (!mayAssignRole(actor, role)) throw forbidden('You cannot create this account type.');

  // A manager's new users always report to that manager.
  const actorManagesAll = getScope(actor, FEATURE, 'create') === 'all';
  const managerId = actorManagesAll ? (data.managerId ?? null) : actor._id;
  if (managerId && !(await User.exists({ _id: managerId, status: { $ne: 'deactivated' } }))) {
    throw badRequest('The chosen manager does not exist', [{ field: 'managerId' }]);
  }

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
    passwordHash: await hashPassword(data.password),
    mustChangePassword: true,
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
  return toUserView(user.toObject(), new Map([[String(role._id), role]]));
}

/**
 * Change a user's name, phone, account type, manager or status.
 * @param {object} actor
 * @param {string} userId
 * @param {{ name?: string, phone?: string | null, roleId?: string, managerId?: string | null, status?: 'active' | 'deactivated' }} changes
 * @param {{ requestId?: string }} [context]
 */
export async function updateUser(actor, userId, changes, context = {}) {
  const user = await User.findById(userId).lean();
  // 404, not 403: a manager must not learn that a user outside their team exists.
  if (!user || !canManage(actor, 'edit', user)) throw notFound('User not found');

  const rolesById = await loadRolesById();
  const actorManagesAll = getScope(actor, FEATURE, 'edit') === 'all';
  const update = {};

  if (changes.name !== undefined) update.name = changes.name;
  if (changes.phone !== undefined) update.phone = changes.phone ?? undefined;

  if (changes.roleId !== undefined && !sameId(changes.roleId, user.roleId)) {
    const role = rolesById.get(String(changes.roleId));
    if (!role) throw badRequest('Choose an account type', [{ field: 'roleId' }]);
    if (!mayAssignRole(actor, role)) throw forbidden('You cannot give this account type.');
    await assertAnotherAdminRemains(user._id, rolesById);
    update.roleId = role._id;
  }

  if (changes.managerId !== undefined && actorManagesAll) {
    if (sameId(changes.managerId, user._id)) {
      throw badRequest('A user cannot be their own manager', [{ field: 'managerId' }]);
    }
    update.managerId = changes.managerId;
  }

  if (changes.status !== undefined && changes.status !== user.status) {
    if (sameId(user._id, actor._id)) throw conflict('You cannot deactivate your own account.');
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
  if (!changed) return toUserView(user, rolesById);

  await User.updateOne({ _id: user._id }, { $set: update });
  // A deactivated user is signed out at once, everywhere.
  if (update.status === 'deactivated') await revokeUserSessions(user._id);

  await writeAudit({
    actor,
    action: update.status === 'deactivated' ? 'user.deactivated' : 'user.updated',
    entityType: 'users',
    entityId: user._id,
    oldValue,
    newValue,
    requestId: context.requestId,
  });
  return toUserView({ ...user, ...update }, rolesById);
}

/**
 * Set a new password for another user. They are signed out everywhere and must choose their
 * own password at the next sign-in.
 */
export async function resetUserPassword(actor, userId, password, context = {}) {
  const user = await User.findById(userId).lean();
  if (!user || !canManage(actor, 'edit', user)) throw notFound('User not found');
  if (sameId(user._id, actor._id)) {
    throw conflict('Use "Change password" to change your own password.');
  }

  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        passwordHash: await hashPassword(password),
        mustChangePassword: true,
        passwordChangedAt: new Date(),
      },
    },
  );
  await revokeUserSessions(user._id);
  await writeAudit({
    actor,
    action: 'user.password_reset',
    entityType: 'users',
    entityId: user._id,
    requestId: context.requestId,
  });
}
