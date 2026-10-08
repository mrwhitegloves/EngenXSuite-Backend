import { describe, expect, it } from 'vitest';
import { can, getScope } from '../lib/can.js';
import { MATCH_NOTHING, scopeFilter } from '../lib/scopeFilter.js';
import { ACTIONS, DEFAULT_ROLE_GRANTS, FEATURES, SCOPES } from '../constants/permissions.js';

// Users as requireAuth will attach them: an id, the role's grants, and the ids of direct reports.
const makeUser = (id, roleName, teamUserIds = []) => ({
  _id: id,
  role: { name: roleName, grants: DEFAULT_ROLE_GRANTS[roleName] },
  teamUserIds,
});

const ceo = makeUser('ceo', 'CEO');
const manager = makeUser('mgr', 'Sales Manager', ['agentA', 'agentB']);
const agentA = makeUser('agentA', 'Sales Agent');
const agentB = makeUser('agentB', 'Sales Agent');

describe('default role grants are well-formed', () => {
  it('only use features, actions and scopes from the catalogue', () => {
    for (const grants of Object.values(DEFAULT_ROLE_GRANTS)) {
      for (const grant of grants) {
        expect(FEATURES).toContain(grant.feature);
        expect(ACTIONS).toContain(grant.action);
        expect(SCOPES).toContain(grant.scope);
      }
    }
  });

  it('CEO has every action on every feature with scope all', () => {
    for (const feature of FEATURES) {
      for (const action of ACTIONS) expect(getScope(ceo, feature, action)).toBe('all');
    }
  });
});

describe('getScope', () => {
  it('returns the widest scope when several grants match', () => {
    const user = {
      _id: 'u',
      role: {
        grants: [
          { feature: 'tasks', action: 'view', scope: 'own' },
          { feature: 'tasks', action: 'view', scope: 'team' },
        ],
      },
    };
    expect(getScope(user, 'tasks', 'view')).toBe('team');
  });

  it('returns null for a missing grant, a missing role or a missing user', () => {
    expect(getScope(agentA, 'users', 'view')).toBeNull();
    expect(getScope({ _id: 'x' }, 'accounts', 'view')).toBeNull();
    expect(getScope(null, 'accounts', 'view')).toBeNull();
  });
});

describe('can() without a record (is the action allowed at all)', () => {
  it('only the CEO manages users, settings, the audit log and the CEO dashboard', () => {
    for (const feature of ['users', 'settings', 'audit', 'ceo_dashboard']) {
      expect(can(ceo, 'view', { feature })).toBe(true);
      expect(can(manager, 'view', { feature })).toBe(false);
      expect(can(agentA, 'view', { feature })).toBe(false);
    }
  });

  it('agents cannot delete accounts or touch invoices', () => {
    expect(can(agentA, 'delete', { feature: 'accounts' })).toBe(false);
    expect(can(agentA, 'view', { feature: 'invoices' })).toBe(false);
  });
});

describe('can() with a record (scope rules)', () => {
  const accountOfA = { ownerId: 'agentA', assignedUserIds: [] };
  const accountOfBSharedWithA = { ownerId: 'agentB', assignedUserIds: ['agentA'] };
  const accountOfStranger = { ownerId: 'someoneElse', assignedUserIds: [] };

  it('assigned scope: owner or assigned user, nobody else', () => {
    expect(can(agentA, 'view', { feature: 'accounts', record: accountOfA })).toBe(true);
    expect(can(agentA, 'view', { feature: 'accounts', record: accountOfBSharedWithA })).toBe(true);
    expect(can(agentB, 'view', { feature: 'accounts', record: accountOfA })).toBe(false);
    expect(can(agentA, 'view', { feature: 'accounts', record: accountOfStranger })).toBe(false);
  });

  it('own scope: only the owner, even when assigned', () => {
    const task = { ownerId: 'agentB', assignedUserIds: ['agentA'] };
    expect(can(agentB, 'edit', { feature: 'tasks', record: task })).toBe(true);
    expect(can(agentA, 'edit', { feature: 'tasks', record: task })).toBe(false);
  });

  it('team scope: own records and those of direct reports, not other teams', () => {
    const taskOfReport = { ownerId: 'agentA' };
    const taskOfOtherTeam = { ownerId: 'someoneElse' };
    expect(can(manager, 'edit', { feature: 'tasks', record: taskOfReport })).toBe(true);
    expect(can(manager, 'edit', { feature: 'tasks', record: taskOfOtherTeam })).toBe(false);
  });

  it('a custom owner field is respected', () => {
    const task = { assigneeId: 'agentA' };
    expect(can(agentA, 'edit', { feature: 'tasks', record: task, ownerField: 'assigneeId' })).toBe(
      true,
    );
    expect(can(agentB, 'edit', { feature: 'tasks', record: task, ownerField: 'assigneeId' })).toBe(
      false,
    );
  });

  it('compares ids as strings, so ObjectId-like values match their string form', () => {
    const objectIdLike = { toString: () => 'agentA' };
    expect(can(agentA, 'view', { feature: 'accounts', record: { ownerId: objectIdLike } })).toBe(
      true,
    );
  });
});

// Founder decision 0008. This is a hard rule of the product, so it is tested from every side.
describe('lead access: CEO all, Sales Agent only assigned leads', () => {
  const feature = 'opportunities';
  const leadOwnedByA = { ownerId: 'agentA', assignedUserIds: [] };
  const leadSharedWithA = { ownerId: 'agentB', assignedUserIds: ['agentA'] };
  const leadOfB = { ownerId: 'agentB', assignedUserIds: [] };
  const unassignedLead = { ownerId: null, assignedUserIds: [] };
  const leadOfOtherTeam = { ownerId: 'someoneElse', assignedUserIds: [] };

  it('the CEO can view and edit every lead, including unassigned ones', () => {
    for (const record of [leadOwnedByA, leadOfB, unassignedLead, leadOfOtherTeam]) {
      expect(can(ceo, 'view', { feature, record })).toBe(true);
      expect(can(ceo, 'edit', { feature, record })).toBe(true);
    }
  });

  it('a Sales Agent can view and edit leads they own or are assigned to', () => {
    for (const record of [leadOwnedByA, leadSharedWithA]) {
      expect(can(agentA, 'view', { feature, record })).toBe(true);
      expect(can(agentA, 'edit', { feature, record })).toBe(true);
    }
  });

  it('a Sales Agent can neither view nor edit a lead assigned to someone else', () => {
    for (const record of [leadOfB, leadOfOtherTeam]) {
      expect(can(agentA, 'view', { feature, record })).toBe(false);
      expect(can(agentA, 'edit', { feature, record })).toBe(false);
    }
  });

  it('a Sales Agent can neither view nor edit an unassigned lead', () => {
    expect(can(agentA, 'view', { feature, record: unassignedLead })).toBe(false);
    expect(can(agentA, 'edit', { feature, record: unassignedLead })).toBe(false);
  });

  it('a Sales Agent cannot delete, export or reassign leads at all', () => {
    for (const action of ['delete', 'export', 'assign']) {
      expect(can(agentA, action, { feature })).toBe(false);
    }
  });

  it('a Sales Manager sees the leads of their team but not unassigned or other teams', () => {
    expect(can(manager, 'view', { feature, record: leadOwnedByA })).toBe(true);
    expect(can(manager, 'view', { feature, record: unassignedLead })).toBe(false);
    expect(can(manager, 'view', { feature, record: leadOfOtherTeam })).toBe(false);
  });

  it('the list and search filter for an agent matches only owned or assigned leads', () => {
    // Every list and search query for leads is combined with this filter, so a lead outside it
    // cannot be found by any search term.
    expect(scopeFilter(agentA, feature)).toEqual({
      $or: [{ ownerId: 'agentA' }, { assignedUserIds: 'agentA' }],
    });
    expect(scopeFilter(agentA, feature, { action: 'edit' })).toEqual({
      $or: [{ ownerId: 'agentA' }, { assignedUserIds: 'agentA' }],
    });
    expect(scopeFilter(ceo, feature)).toEqual({});
  });
});

describe('scopeFilter (list queries)', () => {
  it('no access matches nothing, never everything', () => {
    expect(scopeFilter(agentA, 'users')).toBe(MATCH_NOTHING);
  });

  it('scope all adds no restriction', () => {
    expect(scopeFilter(ceo, 'accounts')).toEqual({});
  });

  it('scope own filters on the owner field', () => {
    expect(scopeFilter(agentA, 'tasks', { ownerField: 'assigneeId' })).toEqual({
      assigneeId: 'agentA',
    });
  });

  it('scope assigned matches owned or assigned records', () => {
    expect(scopeFilter(agentA, 'accounts')).toEqual({
      $or: [{ ownerId: 'agentA' }, { assignedUserIds: 'agentA' }],
    });
  });

  it('scope team includes the user and their direct reports', () => {
    expect(scopeFilter(manager, 'tasks')).toEqual({
      $or: [{ ownerId: { $in: ['mgr', 'agentA', 'agentB'] } }, { assignedUserIds: 'mgr' }],
    });
  });
});
