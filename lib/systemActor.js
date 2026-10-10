import { ACTIONS, FEATURES } from '../constants/permissions.js';

// The "person" behind what the system does by itself (an inbound lead from an ad, a scheduled
// job). Services take an actor and check its permissions; this one may do everything, has no
// user id (so audit entries and "created by" stay empty: nobody typed it) and no team.
// Use it ONLY in code that no person's request reaches directly.

const ALL_GRANTS = FEATURES.flatMap((feature) =>
  ACTIONS.map((action) => ({ feature, action, scope: 'all' })),
);

export function systemActor() {
  return {
    _id: null,
    name: 'System',
    role: { name: 'System', grants: ALL_GRANTS },
    teamUserIds: [],
  };
}
