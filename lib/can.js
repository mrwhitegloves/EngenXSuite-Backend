import { scopeRank } from '../constants/permissions.js';

// The ONE permission function of the backend. Every endpoint decides access through these
// functions; no other file compares role names or reads grants directly.
//
// The `user` object passed in is the one requireAuth attaches to the request:
//   { _id, role: { grants: [{ feature, action, scope }] }, teamUserIds: [ids of people reporting to the user] }

const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const includesId = (list, id) => Array.isArray(list) && list.some((item) => sameId(item, id));

/**
 * The widest scope the user holds for an action on a feature, or null when they hold none.
 * @returns {'own' | 'assigned' | 'team' | 'all' | null}
 */
export function getScope(user, feature, action) {
  const grants = user?.role?.grants ?? [];
  let best = null;
  for (const grant of grants) {
    if (grant.feature !== feature || grant.action !== action) continue;
    if (best === null || scopeRank(grant.scope) > scopeRank(best)) best = grant.scope;
  }
  return best;
}

/**
 * May this user perform this action?
 * Without a record: "is the action allowed at all" (used before listing or creating).
 * With a record: "is it allowed on THIS record", using the record's owner and assigned users.
 *
 * @param {object} user
 * @param {string} action   One of ACTIONS
 * @param {{ feature: string, record?: object, ownerField?: string, assignedField?: string }} resource
 * @returns {boolean}
 */
export function can(user, action, resource) {
  const { feature, record, ownerField = 'ownerId', assignedField = 'assignedUserIds' } = resource;
  const scope = getScope(user, feature, action);
  if (scope === null) return false;
  if (!record || scope === 'all') return true;

  const ownerId = record[ownerField];
  if (sameId(ownerId, user._id)) return true;
  if (scope === 'own') return false;

  const isAssigned = includesId(record[assignedField], user._id);
  if (scope === 'assigned') return isAssigned;

  // scope === 'team': the user's own records plus those of the people who report to them.
  return isAssigned || includesId(user.teamUserIds, ownerId);
}
