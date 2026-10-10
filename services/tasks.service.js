import { SOCKET_EVENTS } from '../constants/socketEvents.js';
import { emitToAll } from '../infra/realtime.js';
import { writeAudit } from '../lib/audit.js';
import { can, getScope } from '../lib/can.js';
import { planChanges, toUpdate } from '../lib/changes.js';
import { resolveDateRange } from '../lib/dateRange.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { buildFilter, runListQuery } from '../lib/queryBuilder.js';
import { scopeFilter } from '../lib/scopeFilter.js';
import { Account } from '../models/account.model.js';
import { Contact } from '../models/contact.model.js';
import { Opportunity } from '../models/opportunity.model.js';
import { TASK_PRIORITIES, TASK_TYPES, Task } from '../models/task.model.js';
import { User } from '../models/user.model.js';
import { loadAccountForAction } from './accounts.service.js';
import { recordActivity } from './activities.service.js';
import { loadLeadForAction } from './opportunities.service.js';

// Tasks: the one task system of everyone (Master Prompt Section 33).
//
// Who sees a task:
//   - the person it is assigned to and the person who created it, always
//   - beyond that, the "tasks" permission scope: a manager the tasks of their team, the CEO all
//   - on the page of a lead or a company: everyone who may see that record sees its tasks
// A task about a lead is reached only by someone who may see that lead (decision 0008).

const FEATURE = 'tasks';
// For can(): the "owner" of a task is the person it is assigned to.
const OWNERSHIP = { ownerField: 'assigneeId' };
const OPEN_STATUSES = ['open', 'in_progress'];
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const fieldProblem = (field, message) => badRequest(message, [{ field, message }]);
const announce = () => emitToAll(SOCKET_EVENTS.tasksChanged);
const isMine = (actor, task) =>
  sameId(task.assigneeId, actor._id) || sameId(task.createdBy, actor._id);

/**
 * May the actor do this with this task? Yes when their "tasks" permission for the action
 * reaches the task's assignee, or when they hold the permission at all and the task is their
 * own (assigned to them, or created by them).
 */
function allowed(actor, action, task) {
  if (isMine(actor, task) && can(actor, action, { feature: FEATURE })) return true;
  return can(actor, action, { feature: FEATURE, record: task, ...OWNERSHIP });
}

/** True when the actor may see the lead or company the task is about. */
async function seesLinkedRecord(actor, task) {
  try {
    if (task.opportunityId) await loadLeadForAction(actor, task.opportunityId, 'view');
    else if (task.accountId) await loadAccountForAction(actor, task.accountId, 'view');
    else return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Load one task for an action. Not visible: "not found". Visible but not allowed: "forbidden".
 * A task about a lead the actor may not see is "not found", whoever it is assigned to.
 */
async function loadTaskForAction(actor, taskId, action) {
  const task = await Task.findById(taskId).lean();
  if (!task) throw notFound('Task not found');
  const viaRecord = await seesLinkedRecord(actor, task);
  if (task.opportunityId && !viaRecord) throw notFound('Task not found');
  if (!viaRecord && !allowed(actor, 'view', task)) throw notFound('Task not found');
  if (action !== 'view' && !allowed(actor, action, task)) {
    throw forbidden('You do not have permission to do this with this task.');
  }
  return task;
}

async function loadLookups(tasks) {
  const ids = (pick) => [...new Set(tasks.flatMap(pick).filter(Boolean).map(String))];
  const byId = (items) => new Map(items.map((item) => [String(item._id), item]));
  const [users, accounts, leads, contacts] = await Promise.all([
    User.find({ _id: { $in: ids((task) => [task.assigneeId, task.createdBy]) } })
      .select('name')
      .lean(),
    Account.find({ _id: { $in: ids((task) => [task.accountId]) } })
      .select('name')
      .lean(),
    Opportunity.find({ _id: { $in: ids((task) => [task.opportunityId]) } })
      .select('name leadCode')
      .lean(),
    Contact.find({ _id: { $in: ids((task) => [task.contactId]) } })
      .select('name')
      .lean(),
  ]);
  return {
    users: byId(users),
    accounts: byId(accounts),
    leads: byId(leads),
    contacts: byId(contacts),
  };
}

function toView(task, lookups, actor, now = new Date()) {
  const named = (map, id) => {
    const item = id && map.get(String(id));
    return item ? { id: String(item._id), name: item.name } : null;
  };
  const isOpen = OPEN_STATUSES.includes(task.status);
  return {
    id: String(task._id),
    title: task.title,
    description: task.description ?? null,
    type: task.type,
    status: task.status,
    priority: task.priority,
    dueAt: task.dueAt ?? null,
    // Worked out here, so every screen agrees on what "overdue" means.
    isOverdue: isOpen && Boolean(task.dueAt) && task.dueAt < now,
    completedAt: task.completedAt ?? null,
    assignee: named(lookups.users, task.assigneeId),
    createdBy: named(lookups.users, task.createdBy),
    account: named(lookups.accounts, task.accountId),
    lead: named(lookups.leads, task.opportunityId),
    contact: named(lookups.contacts, task.contactId),
    source: task.source,
    createdAt: task.createdAt,
    permissions: {
      canEdit: allowed(actor, 'edit', task),
      canDelete: allowed(actor, 'delete', task),
    },
  };
}

async function viewOf(task, actor) {
  return toView(task, await loadLookups([task]), actor);
}

/** The tasks filter of the four views. Day boundaries are those of India. */
function viewFilter(view, now) {
  const today = resolveDateRange({ range: 'today' }, now);
  const open = { status: { $in: OPEN_STATUSES } };
  if (view === 'today') return { ...open, dueAt: { $gte: today.from, $lt: today.to } };
  if (view === 'overdue') return { ...open, dueAt: { $lt: today.from } };
  // Upcoming: due after today, or with no due date at all.
  if (view === 'upcoming')
    return { ...open, $or: [{ dueAt: { $gte: today.to } }, { dueAt: null }] };
  if (view === 'completed') return { status: 'done' };
  if (view === 'open') return open;
  return {};
}

/**
 * Tasks, for the Activities page (the actor's scope) or for one lead or company (everyone who
 * may see that record sees its tasks).
 * @param {{ view?: string, assigneeId?: string, opportunityId?: string, accountId?: string,
 *           search?: string, page: number, pageSize: number }} query  Validated
 */
export async function listTasks(actor, query, now = new Date()) {
  let scope;
  const equals = { assigneeId: query.assigneeId };
  if (query.opportunityId) {
    const lead = await loadLeadForAction(actor, query.opportunityId, 'view');
    equals.opportunityId = lead._id;
  } else if (query.accountId) {
    const account = await loadAccountForAction(actor, query.accountId, 'view');
    equals.accountId = account._id;
    // Tasks of this company's leads only when the person may see those leads.
    const leadScope = scopeFilter(actor, 'opportunities');
    if (Object.keys(leadScope).length > 0) {
      const visible = await Opportunity.distinct('_id', {
        $and: [leadScope, { accountId: account._id }],
      });
      scope = { $or: [{ opportunityId: null }, { opportunityId: { $in: visible } }] };
    }
  } else {
    const byPermission = scopeFilter(actor, FEATURE, {
      ownerField: 'assigneeId',
      assignedField: 'createdBy',
    });
    // "All" needs no filter; otherwise one's own tasks are always included.
    scope =
      Object.keys(byPermission).length === 0
        ? {}
        : { $or: [byPermission, { assigneeId: actor._id }, { createdBy: actor._id }] };
  }

  const isDone = query.view === 'completed';
  const { rows, pagination } = await runListQuery(Task, {
    filter: buildFilter({
      scope,
      equals,
      search: { text: query.search, fields: ['title'] },
      extra: [viewFilter(query.view, now)],
    }),
    // What was finished last comes first; open tasks by what is due first.
    sort: isDone ? { completedAt: -1, _id: -1 } : { dueAt: 1, _id: 1 },
    page: query.page,
    pageSize: query.pageSize,
  });
  // Within the same due time, the more important task first.
  if (!isDone) {
    rows.sort(
      (a, b) =>
        (a.dueAt ? +a.dueAt : Infinity) - (b.dueAt ? +b.dueAt : Infinity) ||
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
    );
  }
  const lookups = await loadLookups(rows);
  return { items: rows.map((task) => toView(task, lookups, actor, now)), pagination };
}

/** How many open tasks the actor has in each view (the numbers on the Activities tabs). */
export async function countMyTasks(actor, now = new Date()) {
  const mine = { assigneeId: actor._id };
  const [today, overdue, upcoming] = await Promise.all(
    ['today', 'overdue', 'upcoming'].map((view) =>
      Task.countDocuments({ $and: [mine, viewFilter(view, now)] }),
    ),
  );
  return { today, overdue, upcoming };
}

export async function getTaskFormOptions(actor) {
  // People a task can be given to: everyone, one's own team, or only oneself.
  const assignScope = getScope(actor, FEATURE, 'assign');
  const canAssign = assignScope !== null;
  const teamIds = [actor._id, ...(actor.teamUserIds ?? [])];
  let filter = { _id: actor._id };
  if (assignScope === 'all') filter = { status: 'active' };
  else if (canAssign) filter = { _id: { $in: teamIds }, status: 'active' };
  const users = await User.find(filter).select('name').sort({ name: 1 }).lean();
  return {
    users: users.map((user) => ({ id: String(user._id), name: user.name })),
    types: TASK_TYPES,
    priorities: TASK_PRIORITIES,
    canAssign,
  };
}

/** What a task is about: the lead (with its company), or a company, optionally a contact. */
async function resolveLinks(actor, data) {
  const links = {};
  if (data.opportunityId) {
    const lead = await loadLeadForAction(actor, data.opportunityId, 'view');
    links.opportunityId = lead._id;
    links.accountId = lead.accountId;
  } else if (data.accountId) {
    links.accountId = (await loadAccountForAction(actor, data.accountId, 'view'))._id;
  }
  if (data.contactId) {
    const contact = await Contact.findOne({ _id: data.contactId, deletedAt: null }).lean();
    if (!contact || (links.accountId && !sameId(contact.accountId, links.accountId))) {
      throw fieldProblem('contactId', 'Choose a person of this company');
    }
    if (!links.accountId) {
      links.accountId = (await loadAccountForAction(actor, contact.accountId, 'view'))._id;
    }
    links.contactId = contact._id;
  }
  return links;
}

/** Giving a task to someone else needs the "assign" permission, inside its scope. */
async function assertAssignable(actor, assigneeId) {
  if (sameId(assigneeId, actor._id)) return;
  const record = { feature: FEATURE, record: { assigneeId }, ...OWNERSHIP };
  if (!can(actor, 'assign', record)) {
    throw forbidden('You can give tasks only to yourself.');
  }
  if (!(await User.exists({ _id: assigneeId, status: 'active' }))) {
    throw fieldProblem('assigneeId', 'Choose an active user');
  }
}

/** The timeline entry of a task event, when the task is about a lead, company or contact. */
async function onTimeline(task, actor, subtype, title, occurredAt) {
  if (!task.accountId && !task.opportunityId && !task.contactId) return;
  await recordActivity({
    type: 'TASK',
    direction: 'internal',
    subtype,
    title,
    accountId: task.accountId,
    opportunityId: task.opportunityId,
    contactId: task.contactId,
    userId: actor._id,
    occurredAt,
    refCollection: 'tasks',
    refId: task._id,
    metadata: { dueAt: task.dueAt ?? null },
  });
}

/** @param {object} data  Already validated (validation/tasks.js createTaskBody) */
export async function createTask(actor, data, context = {}) {
  const { assigneeId = String(actor._id), opportunityId, accountId, contactId, ...rest } = data;
  await assertAssignable(actor, assigneeId);
  const links = await resolveLinks(actor, { opportunityId, accountId, contactId });

  const fields = Object.fromEntries(
    Object.entries(rest).filter(([, value]) => value !== null && value !== undefined),
  );
  const task = (
    await Task.create({ ...fields, ...links, assigneeId, createdBy: actor._id, source: 'manual' })
  ).toObject();

  await writeAudit({
    actor,
    action: 'task.created',
    entityType: 'tasks',
    entityId: task._id,
    newValue: { title: task.title, assigneeId: String(task.assigneeId) },
    requestId: context.requestId,
  });
  await onTimeline(task, actor, 'task_created', `Task: ${task.title}`, task.createdAt);
  announce();
  return viewOf(task, actor);
}

export async function getTask(actor, taskId) {
  return viewOf(await loadTaskForAction(actor, taskId, 'view'), actor);
}

/**
 * Change a task. Setting the status to "done" completes it (the time is recorded); any other
 * status reopens it. What the task is about cannot be changed afterwards.
 * @param {object} changes  Already validated (validation/tasks.js updateTaskBody)
 */
export async function updateTask(actor, taskId, changes, context = {}) {
  const task = await loadTaskForAction(actor, taskId, 'edit');
  const plan = planChanges(task, changes);
  if (plan.fields.length === 0) return viewOf(task, actor);
  if (plan.fields.includes('assigneeId')) await assertAssignable(actor, changes.assigneeId);

  const now = new Date();
  const becomesDone = plan.fields.includes('status') && changes.status === 'done';
  const reopens = plan.fields.includes('status') && task.status === 'done';
  if (becomesDone) plan.set.completedAt = now;
  if (reopens) plan.unset.completedAt = '';

  await Task.updateOne({ _id: task._id }, toUpdate(plan), { runValidators: true });
  await writeAudit({
    actor,
    action: becomesDone ? 'task.completed' : 'task.updated',
    entityType: 'tasks',
    entityId: task._id,
    oldValue: plan.oldValue,
    newValue: plan.newValue,
    requestId: context.requestId,
  });
  // Written once per task: completing it again after a reopen does not add a second entry.
  if (becomesDone) await onTimeline(task, actor, 'task_completed', `Task done: ${task.title}`, now);
  announce();
  return viewOf(await Task.findById(task._id).lean(), actor);
}

export async function deleteTask(actor, taskId, context = {}) {
  const task = await loadTaskForAction(actor, taskId, 'delete');
  await Task.deleteOne({ _id: task._id });
  await writeAudit({
    actor,
    action: 'task.deleted',
    entityType: 'tasks',
    entityId: task._id,
    oldValue: { title: task.title, assigneeId: String(task.assigneeId) },
    requestId: context.requestId,
  });
  announce();
}
