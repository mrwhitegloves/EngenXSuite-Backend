import { SOCKET_EVENTS } from '../constants/socketEvents.js';
import { emitToAll } from '../infra/realtime.js';
import { writeAudit } from '../lib/audit.js';
import { badRequest } from '../lib/errors.js';
import { Opportunity } from '../models/opportunity.model.js';
import { Role } from '../models/role.model.js';
import { ASSIGNMENT_MODES, Settings } from '../models/settings.model.js';
import { User } from '../models/user.model.js';

// Who gets a lead that arrives by itself (a Meta lead ad, later the website). The CEO chooses
// the rule in Settings → Lead assignment (founder decision, 2026-10-11):
//
//   off                   nobody: the lead stays unassigned, the CEO and managers give it out
//   round_robin_all       every sales agent in turn
//   round_robin_selected  the chosen people in turn
//   fixed                 always the same person
//   least_open            the person with the fewest open leads (among the chosen people, or
//                         among all sales agents when nobody is chosen)
//
// Before the rule: a form's own owner (lead_forms.defaultOwnerId) wins.
// In every case: someone marked "away" and someone who is not an active user gets nothing.

const DEFAULTS = { mode: 'round_robin_all', userIds: [], fixedUserId: null, awayUserIds: [] };
const idsOf = (list) => (list ?? []).map(String);

async function readRule() {
  const settings = await Settings.findOne({ key: 'app' }).select('leadAssignment').lean();
  return { ...DEFAULTS, ...settings?.leadAssignment };
}

/**
 * The sales agents: active users whose account type lets them work only on leads that are
 * theirs (scope "own" or "assigned"). Decided from the permissions, not from a role's name.
 */
async function salesAgents() {
  const roles = await Role.find({
    grants: {
      $elemMatch: {
        feature: 'opportunities',
        action: 'edit',
        scope: { $in: ['own', 'assigned'] },
      },
    },
  })
    .select('_id')
    .lean();
  return User.find({ roleId: { $in: roles.map((role) => role._id) }, status: 'active' })
    .select('name roleId')
    .sort({ name: 1, _id: 1 })
    .lean();
}

/** What the settings screen shows: the rule, and the people it can name. */
export async function getLeadAssignment() {
  const [rule, agents, everyone, roles] = await Promise.all([
    readRule(),
    salesAgents(),
    User.find({ status: 'active' }).select('name roleId').sort({ name: 1, _id: 1 }).lean(),
    Role.find().select('name').lean(),
  ]);
  const roleName = (id) => roles.find((role) => String(role._id) === String(id))?.name ?? null;
  const agentIds = idsOf(agents.map((agent) => agent._id));
  const away = idsOf(rule.awayUserIds);
  return {
    mode: rule.mode,
    modes: ASSIGNMENT_MODES,
    userIds: idsOf(rule.userIds),
    fixedUserId: rule.fixedUserId ? String(rule.fixedUserId) : null,
    awayUserIds: away,
    // Every active user can be chosen; "isAgent" marks who "all sales agents" means.
    users: everyone.map((user) => ({
      id: String(user._id),
      name: user.name,
      roleName: roleName(user.roleId),
      isAgent: agentIds.includes(String(user._id)),
      isAway: away.includes(String(user._id)),
    })),
  };
}

/**
 * Change the rule.
 * @param {{ mode?: string, userIds?: string[], fixedUserId?: string | null,
 *           awayUserIds?: string[] }} changes  Already validated
 */
export async function updateLeadAssignment(actor, changes, context = {}) {
  const before = await readRule();
  const next = { ...before, ...changes };

  const named = [...idsOf(next.userIds), ...idsOf(next.awayUserIds), next.fixedUserId].filter(
    Boolean,
  );
  const active = await User.countDocuments({ _id: { $in: named }, status: 'active' });
  if (active !== new Set(named.map(String)).size) throw badRequest('Choose active users only');
  if (next.mode === 'fixed' && !next.fixedUserId) {
    throw badRequest('Choose the person who gets every lead', [{ field: 'fixedUserId' }]);
  }
  if (next.mode === 'round_robin_selected' && idsOf(next.userIds).length === 0) {
    throw badRequest('Choose at least one person', [{ field: 'userIds' }]);
  }

  const settings = await Settings.findOneAndUpdate(
    { key: 'app' },
    {
      $set: {
        'leadAssignment.mode': next.mode,
        'leadAssignment.userIds': next.userIds,
        'leadAssignment.fixedUserId': next.fixedUserId,
        'leadAssignment.awayUserIds': next.awayUserIds,
      },
    },
    { returnDocument: 'after' },
  ).lean();
  if (!settings) throw badRequest('The settings are not set up yet. Run the seed first.');

  const audited = (rule) => ({
    mode: rule.mode,
    userIds: idsOf(rule.userIds),
    fixedUserId: rule.fixedUserId ? String(rule.fixedUserId) : null,
    awayUserIds: idsOf(rule.awayUserIds),
  });
  await writeAudit({
    actor,
    action: 'settings.lead_assignment_updated',
    entityType: 'settings',
    entityId: settings._id,
    oldValue: audited(before),
    newValue: audited(next),
    requestId: context.requestId,
  });
  emitToAll(SOCKET_EVENTS.inboundLeadsChanged);
  return getLeadAssignment();
}

/**
 * Choose the owner of a new inbound lead.
 * @param {{ formOwnerId?: unknown }} [options]  The owner set on the lead's form, when it has one
 * @returns {Promise<import('mongoose').Types.ObjectId | null>}  null: leave the lead unassigned
 */
export async function pickLeadOwner({ formOwnerId } = {}) {
  const rule = await readRule();
  const away = idsOf(rule.awayUserIds);
  // People who can take a lead now: active, and not away.
  const usable = async (ids) => {
    const wanted = idsOf(ids).filter((id) => !away.includes(id));
    if (wanted.length === 0) return [];
    const users = await User.find({ _id: { $in: wanted }, status: 'active' })
      .select('_id')
      .sort({ _id: 1 })
      .lean();
    return users.map((user) => user._id);
  };

  if (formOwnerId) {
    const [owner] = await usable([formOwnerId]);
    if (owner) return owner;
  }
  if (rule.mode === 'off') return null;
  if (rule.mode === 'fixed') return (await usable([rule.fixedUserId]))[0] ?? null;

  // "Selected" uses the chosen people; "all" every sales agent; "fewest open leads" the chosen
  // people when some are chosen, otherwise every sales agent.
  const chosen = idsOf(rule.userIds);
  const useChosen =
    rule.mode === 'round_robin_selected' || (rule.mode === 'least_open' && chosen.length > 0);
  const pool = await usable(useChosen ? chosen : (await salesAgents()).map((agent) => agent._id));
  if (pool.length === 0) return null;

  // The turn order: the person after the one who got the last lead.
  const lastIndex = pool.findIndex((id) => String(id) === String(rule.lastAssignedUserId));
  const inTurn = [...pool.slice(lastIndex + 1), ...pool.slice(0, lastIndex + 1)];

  let owner = inTurn[0];
  if (rule.mode === 'least_open') {
    const counts = await Opportunity.aggregate([
      { $match: { ownerId: { $in: pool }, status: 'open', deletedAt: null } },
      { $group: { _id: '$ownerId', count: { $sum: 1 } } },
    ]);
    const openOf = (id) => counts.find((item) => String(item._id) === String(id))?.count ?? 0;
    // The fewest open leads; among equals, whose turn it is.
    owner = inTurn.reduce((best, id) => (openOf(id) < openOf(best) ? id : best), inTurn[0]);
  }
  await Settings.updateOne(
    { key: 'app' },
    { $set: { 'leadAssignment.lastAssignedUserId': owner } },
  );
  return owner;
}
