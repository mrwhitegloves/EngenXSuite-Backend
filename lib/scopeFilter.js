import { getScope } from './can.js';
import { TEAM_SEES_UNOWNED } from '../constants/permissions.js';

// Turns a user's scope into a MongoDB filter for LIST queries, so a list can never return a record
// the user may not see. Every list service must combine its own filters with this one:
//   Model.find({ $and: [scopeFilter(user, 'accounts'), userFilters] })

// A filter that matches nothing. Used when the user has no access at all, so a forgotten
// "is null?" check in a service still returns an empty list instead of everything.
export const MATCH_NOTHING = Object.freeze({ _id: { $exists: false } });

/**
 * @param {object} user  The request user: { _id, role: { grants }, teamUserIds }
 * @param {string} feature
 * @param {{ action?: string, ownerField?: string, assignedField?: string }} [options]
 * @returns {object} A MongoDB filter. `{}` means "no restriction" (scope ALL).
 */
export function scopeFilter(user, feature, options = {}) {
  const { action = 'view', ownerField = 'ownerId', assignedField = 'assignedUserIds' } = options;
  const scope = getScope(user, feature, action);

  if (scope === null) return MATCH_NOTHING;
  if (scope === 'all') return {};
  if (scope === 'own') return { [ownerField]: user._id };

  const ownOrAssigned = [{ [ownerField]: user._id }, { [assignedField]: user._id }];
  if (scope === 'assigned') return { $or: ownOrAssigned };

  // scope === 'team'
  const teamIds = [user._id, ...(user.teamUserIds ?? [])];
  const conditions = [{ [ownerField]: { $in: teamIds } }, { [assignedField]: user._id }];
  // Leads nobody owns yet are visible to managers so they can assign them. `null` in a MongoDB
  // filter matches both a null value and a missing field.
  if (TEAM_SEES_UNOWNED.includes(feature)) conditions.push({ [ownerField]: null });
  return { $or: conditions };
}
