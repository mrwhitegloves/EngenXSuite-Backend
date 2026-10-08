// The permission catalogue: which features exist and which actions and scopes a role can be given.
// Roles and their grants are DATA (the `roles` collection); only this list of what can be granted
// is code, because it changes only when code adds a feature.
// The client never imports this file (it is a separate repository). It learns what the signed-in
// user may do from the API (GET /api/auth/me returns the user's grants).

export const ACTIONS = ['view', 'create', 'edit', 'delete', 'export', 'assign', 'approve'];

// Ordered from narrowest to widest. A wider scope includes the narrower ones.
//   own      : records the user owns
//   assigned : records the user owns or is assigned to
//   team     : records owned by the user or by people who report to the user
//   all      : every record
export const SCOPES = ['own', 'assigned', 'team', 'all'];

export const FEATURES = [
  'accounts',
  'plants',
  'contacts',
  'opportunities',
  'tasks',
  'calls',
  'email',
  'whatsapp',
  'meetings',
  'proposals',
  'invoices',
  'documents',
  'reports',
  'ai_insights',
  'ceo_dashboard',
  'campaigns',
  'imports',
  'website',
  'chat',
  'users',
  'settings',
  'audit',
];

// Features where a user with TEAM scope also sees records that have no owner yet.
// Leads: the CEO and Sales Managers assign unassigned leads, so managers must be able to see
// them. Sales Agents (scope "assigned") never see an unassigned lead (decision 0008).
export const TEAM_SEES_UNOWNED = ['opportunities'];

/** Rank of a scope; higher means wider. Unknown scopes rank below everything. */
export function scopeRank(scope) {
  return SCOPES.indexOf(scope);
}

const all = (feature, actions) => actions.map((action) => ({ feature, action, scope: 'all' }));
const scoped = (feature, actions, scope) => actions.map((action) => ({ feature, action, scope }));

const CRUD = ['view', 'create', 'edit', 'delete'];
const WORK = ['view', 'create', 'edit'];

// Seed defaults for the three starting roles (Master Prompt Section 37). The seed script writes
// these into the `roles` collection once; after that the CEO edits them in the permission screen.
// Leads (opportunities), founder decision 0008: the CEO sees and edits every lead; a Sales Agent
// sees and edits ONLY leads assigned to them (owner or in assignedUserIds), in lists, search and by
// direct link; a Sales Manager sees the leads of their own team plus unassigned leads, which the
// CEO and managers assign.
export const DEFAULT_ROLE_GRANTS = {
  CEO: FEATURES.flatMap((feature) => all(feature, ACTIONS)),

  'Sales Manager': [
    ...all('accounts', [...CRUD, 'export', 'assign']),
    ...all('plants', CRUD),
    ...all('contacts', [...CRUD, 'export']),
    ...scoped('opportunities', [...CRUD, 'export', 'assign', 'approve'], 'team'),
    ...scoped('tasks', [...CRUD, 'assign'], 'team'),
    ...scoped('calls', WORK, 'team'),
    ...scoped('email', WORK, 'team'),
    ...scoped('whatsapp', WORK, 'team'),
    ...scoped('meetings', CRUD, 'team'),
    ...all('proposals', [...CRUD, 'approve']),
    ...all('documents', WORK),
    ...scoped('reports', ['view', 'export'], 'team'),
    ...all('ai_insights', ['view']),
    ...scoped('campaigns', [...WORK, 'approve'], 'team'),
    ...all('imports', ['view', 'create']),
    ...all('website', ['view']),
    ...all('chat', WORK),
    // Decision 0009: managers create and manage the user accounts of their own team.
    ...scoped('users', WORK, 'team'),
  ],

  'Sales Agent': [
    ...scoped('accounts', WORK, 'assigned'),
    ...scoped('plants', WORK, 'assigned'),
    ...scoped('contacts', WORK, 'assigned'),
    ...scoped('opportunities', WORK, 'assigned'),
    ...scoped('tasks', CRUD, 'own'),
    ...scoped('calls', WORK, 'own'),
    ...scoped('email', WORK, 'own'),
    ...scoped('whatsapp', WORK, 'own'),
    ...scoped('meetings', CRUD, 'own'),
    ...scoped('proposals', WORK, 'own'),
    ...all('documents', ['view']),
    ...scoped('reports', ['view'], 'own'),
    ...scoped('ai_insights', ['view'], 'own'),
    ...all('chat', WORK),
  ],
};
