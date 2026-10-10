import mongoose from 'mongoose';
import { SOCKET_EVENTS } from '../constants/socketEvents.js';
import { emitToAll } from '../infra/realtime.js';
import { writeAudit } from '../lib/audit.js';
import { can } from '../lib/can.js';
import { planChanges, toUpdate } from '../lib/changes.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { buildFilter, buildSort, runListQuery } from '../lib/queryBuilder.js';
import { scopeFilter } from '../lib/scopeFilter.js';
import { CODE_SERIES, nextCode } from '../lib/sequence.js';
import { Account } from '../models/account.model.js';
import { Contact } from '../models/contact.model.js';
import { Machine } from '../models/machine.model.js';
import {
  BUDGET_STATUSES,
  BUYING_ROLES,
  FEASIBILITY,
  Opportunity,
  RISK_LEVELS,
  SCOPE_LEVELS,
  StageHistory,
} from '../models/opportunity.model.js';
import { PipelineStage } from '../models/pipelineStage.model.js';
import { Plant } from '../models/plant.model.js';
import { PlantUnit } from '../models/plantUnit.model.js';
import { SolutionCategory } from '../models/solutionCategory.model.js';
import { LeadStatus } from '../models/statusLists.model.js';
import { User } from '../models/user.model.js';
import { loadAccountForAction, registerAccountDeleteBlocker } from './accounts.service.js';
import { moveToStage, startingStage, writeFirstStage } from './stage.service.js';
import { assertUsableTags, loadTagsById } from './tags.service.js';

// Leads (the `opportunities` collection). Every function takes the acting user first.
//
// LEAD ACCESS (hard rule, decision 0008):
//   - the CEO sees and edits every lead
//   - a Sales Manager: the leads of their team, plus leads nobody owns yet (to assign them)
//   - a Sales Agent: ONLY leads where they are the owner or listed in assignedUserIds
// Lists go through scopeFilter(); one lead goes through loadLeadForAction(), which answers
// "not found" for a lead outside the scope, so its existence is not revealed.
// Everything attached to a lead (timeline, tasks, calls, messages) must load the lead with
// loadLeadForAction() first.

const FEATURE = 'opportunities';
const NOT_DELETED = { deletedAt: null };
// Small objects: a change is merged into what is already saved.
const NESTED_FIELDS = ['scope', 'nextAction', 'risk'];
const PEOPLE_FIELDS = ['ownerId', 'assignedUserIds'];
const SORT_FIELDS = {
  name: 'name',
  leadCode: 'leadCode',
  createdAt: 'createdAt',
  estimatedValuePaise: 'estimatedValuePaise',
  expectedCloseDate: 'expectedCloseDate',
  stageEnteredAt: 'stageEnteredAt',
  lastActivityAt: 'lastActivityAt',
};

const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const uniqueIds = (ids) => [...new Set(ids.filter(Boolean).map(String))];
const fieldProblem = (field, message) => badRequest(message, [{ field, message }]);
const announce = () => emitToAll(SOCKET_EVENTS.opportunitiesChanged);

/**
 * Load one lead for an action. Outside the user's scope: "not found" (404).
 * Visible, but the action is not allowed on it: "forbidden" (403).
 */
export async function loadLeadForAction(actor, leadId, action) {
  const lead = await Opportunity.findOne({ _id: leadId, ...NOT_DELETED }).lean();
  const record = { feature: FEATURE, record: lead };
  if (!lead || !can(actor, 'view', record)) throw notFound('Lead not found');
  if (action !== 'view' && !can(actor, action, record)) {
    throw forbidden('You do not have permission to do this with this lead.');
  }
  return lead;
}

/** The names behind the ids on a set of leads, fetched once for the whole set. */
async function loadLookups(leads) {
  const ids = (pick) => uniqueIds(leads.flatMap(pick));
  const byId = (items) => new Map(items.map((item) => [String(item._id), item]));
  const find = (model, list, select) =>
    list.length
      ? model
          .find({ _id: { $in: list } })
          .select(select)
          .lean()
      : [];

  const [accounts, plants, contacts, categories, statuses, stages, users, tags] = await Promise.all(
    [
      find(
        Account,
        ids((lead) => [lead.accountId]),
        'name accountCode',
      ),
      find(
        Plant,
        ids((lead) => [lead.plantId]),
        'name',
      ),
      find(
        Contact,
        ids((lead) => [
          lead.primaryContactId,
          ...(lead.stakeholders ?? []).map((item) => item.contactId),
        ]),
        'name designation phone_number email',
      ),
      find(
        SolutionCategory,
        ids((lead) => lead.solutionCategoryIds ?? []),
        'name',
      ),
      find(
        LeadStatus,
        ids((lead) => [lead.leadStatusId]),
        'name color key',
      ),
      find(
        PipelineStage,
        ids((lead) => [lead.stageId]),
        'name type color key',
      ),
      find(
        User,
        ids((lead) => [lead.ownerId, lead.formFilledBy, ...(lead.assignedUserIds ?? [])]),
        'name',
      ),
      loadTagsById(leads.flatMap((lead) => lead.tagIds ?? [])),
    ],
  );
  return {
    accounts: byId(accounts),
    plants: byId(plants),
    contacts: byId(contacts),
    categories: byId(categories),
    statuses: byId(statuses),
    stages: byId(stages),
    users: byId(users),
    tags,
  };
}

const named = (map, id) => {
  const item = id && map.get(String(id));
  return item ? { id: String(item._id), name: item.name } : null;
};

/** What a list row shows. */
function toListView(lead, lookups, actor) {
  const record = { feature: FEATURE, record: lead };
  const stage = lookups.stages.get(String(lead.stageId));
  const status = lookups.statuses.get(String(lead.leadStatusId));
  const contact = lookups.contacts.get(String(lead.primaryContactId));
  const account = lookups.accounts.get(String(lead.accountId));
  return {
    id: String(lead._id),
    leadCode: lead.leadCode,
    name: lead.name,
    account: account
      ? { id: String(account._id), name: account.name, accountCode: account.accountCode }
      : null,
    plant: named(lookups.plants, lead.plantId),
    primaryContact: contact
      ? {
          id: String(contact._id),
          name: contact.name,
          designation: contact.designation ?? null,
          phone_number: contact.phone_number ?? null,
          email: contact.email ?? null,
        }
      : null,
    solutionCategories: (lead.solutionCategoryIds ?? [])
      .map((id) => named(lookups.categories, id))
      .filter(Boolean),
    tags: (lead.tagIds ?? []).map((id) => lookups.tags.get(String(id))).filter(Boolean),
    leadStatus: status
      ? { id: String(status._id), name: status.name, color: status.color ?? null }
      : null,
    stage: stage
      ? { id: String(stage._id), name: stage.name, type: stage.type, color: stage.color ?? null }
      : null,
    stageEnteredAt: lead.stageEnteredAt,
    status: lead.status,
    owner: named(lookups.users, lead.ownerId),
    assignedUsers: (lead.assignedUserIds ?? [])
      .map((id) => named(lookups.users, id))
      .filter(Boolean),
    estimatedValuePaise: lead.estimatedValuePaise ?? null,
    probability: lead.probability ?? null,
    expectedCloseDate: lead.expectedCloseDate ?? null,
    nextAction: lead.nextAction ?? null,
    risk: lead.risk ?? null,
    lastActivityAt: lead.lastActivityAt ?? null,
    createdAt: lead.createdAt,
    updatedAt: lead.updatedAt,
    permissions: {
      canEdit: can(actor, 'edit', record),
      canDelete: can(actor, 'delete', record),
      canAssign: can(actor, 'assign', record),
    },
  };
}

/** Everything about one lead. */
function toDetailView(lead, lookups, actor) {
  return {
    ...toListView(lead, lookups, actor),
    problemStatement: lead.problemStatement ?? null,
    requirement: lead.requirement ?? null,
    expectedImpact: lead.expectedImpact ?? null,
    scope: lead.scope ?? null,
    competitor: lead.competitor ?? null,
    technicalFeasibility: lead.technicalFeasibility ?? null,
    budgetStatus: lead.budgetStatus ?? null,
    decisionTimeline: lead.decisionTimeline ?? null,
    stakeholders: (lead.stakeholders ?? []).map((item) => ({
      contact: named(lookups.contacts, item.contactId),
      buyingRole: item.buyingRole ?? null,
    })),
    closedAt: lead.closedAt ?? null,
    closeReason: lead.closeReason ?? null,
    lostToCompetitor: lead.lostToCompetitor ?? null,
    source: lead.source,
    sourceDetail: lead.sourceDetail ?? null,
    formFilledBy: named(lookups.users, lead.formFilledBy),
  };
}

async function detailOf(lead, actor) {
  return toDetailView(lead, await loadLookups([lead]), actor);
}

// ── Checks on what a lead points at ─────────────────────────────────────────────────────────

async function assertActiveUsers(ids, field) {
  const unique = uniqueIds(ids);
  if (unique.length === 0) return;
  const found = await User.countDocuments({ _id: { $in: unique }, status: 'active' });
  if (found !== unique.length) throw fieldProblem(field, 'Choose active users only');
}

async function defaultLeadStatusId() {
  const status = await LeadStatus.findOne({ isDefault: true, isActive: true }).select('_id').lean();
  if (!status) throw conflict('No lead status exists yet. Add one in Settings → Statuses first.');
  return status._id;
}

/** Everything a lead points at must exist and belong to the lead's own company. */
async function assertUsableLinks(accountId, data) {
  if (data.leadStatusId && !(await LeadStatus.exists({ _id: data.leadStatusId, isActive: true }))) {
    throw fieldProblem('leadStatusId', 'Choose a status from the list');
  }
  if (data.solutionCategoryIds?.length) {
    const found = await SolutionCategory.countDocuments({
      _id: { $in: data.solutionCategoryIds },
      isActive: true,
    });
    if (found !== data.solutionCategoryIds.length) {
      throw fieldProblem('solutionCategoryIds', 'Choose categories from the list');
    }
  }
  if (data.tagIds) await assertUsableTags(data.tagIds, 'opportunity');

  const ofAccount = { accountId, ...NOT_DELETED };
  if (data.plantId && !(await Plant.exists({ _id: data.plantId, ...ofAccount }))) {
    throw fieldProblem('plantId', 'Choose a plant of this company');
  }
  const contactIds = uniqueIds([
    data.primaryContactId,
    ...(data.stakeholders ?? []).map((item) => item.contactId),
  ]);
  if (contactIds.length) {
    const found = await Contact.countDocuments({ _id: { $in: contactIds }, ...ofAccount });
    if (found !== contactIds.length) {
      const field = data.primaryContactId ? 'primaryContactId' : 'stakeholders';
      throw fieldProblem(field, 'Choose people of this company');
    }
  }
  const machineIds = data.scope?.machineIds ?? [];
  const unitIds = data.scope?.unitIds ?? [];
  if (machineIds.length || unitIds.length) {
    const plantIds = await Plant.distinct('_id', ofAccount);
    const inPlants = { plantId: { $in: plantIds } };
    const [machines, units] = await Promise.all([
      Machine.countDocuments({ _id: { $in: machineIds }, ...inPlants, ...NOT_DELETED }),
      PlantUnit.countDocuments({ _id: { $in: unitIds }, ...inPlants }),
    ]);
    if (machines !== machineIds.length || units !== unitIds.length) {
      throw fieldProblem('scope', 'Choose machines, departments and lines of this company');
    }
  }
}

// ── Reading ─────────────────────────────────────────────────────────────────────────────────

/** The database filter of the leads list: the person's scope first, then what they asked for. */
function leadsFilter(actor, query) {
  const { search, range, from, to, ownerId, minValue, maxValue } = query;
  const value = {};
  if (minValue !== undefined) value.$gte = minValue;
  if (maxValue !== undefined) value.$lte = maxValue;
  return buildFilter({
    scope: scopeFilter(actor, FEATURE),
    equals: {
      status: query.status,
      stageId: query.stageId,
      leadStatusId: query.leadStatusId,
      accountId: query.accountId,
      ownerId: ownerId === 'unassigned' ? undefined : ownerId,
      solutionCategoryIds: query.solutionCategoryId,
      tagIds: query.tagId,
    },
    search: { text: search, fields: ['name', 'leadCode'] },
    dates: { field: 'createdAt', query: { range, from, to } },
    extra: [
      NOT_DELETED,
      ownerId === 'unassigned' ? { ownerId: null } : null,
      Object.keys(value).length ? { estimatedValuePaise: value } : null,
    ],
  });
}

/** @param {object} query  Validated (validation/opportunities.js listLeadsQuery) */
export async function listLeads(actor, query) {
  const { rows, pagination } = await runListQuery(Opportunity, {
    filter: leadsFilter(actor, query),
    sort: buildSort(query.sort, SORT_FIELDS, '-createdAt'),
    page: query.page,
    pageSize: query.pageSize,
  });
  const lookups = await loadLookups(rows);
  return { items: rows.map((lead) => toListView(lead, lookups, actor)), pagination };
}

// The most cards one column of the board shows. A fuller column says how many more there are;
// the table view (with pages) shows them all.
export const BOARD_COLUMN_LIMIT = 50;

/**
 * The pipeline board: every active stage as a column, with the leads the person may see.
 * The same filters as the list. Each column also says how many leads it has in all and what
 * they are worth together.
 * @param {object} query  Validated (validation/opportunities.js boardQuery)
 */
export async function getPipelineBoard(actor, query) {
  const filter = leadsFilter(actor, query);
  const stages = await PipelineStage.find({ isActive: true }).sort({ order: 1, _id: 1 }).lean();

  const [totals, ...cardsPerStage] = await Promise.all([
    Opportunity.aggregate([
      { $match: filter },
      {
        $group: {
          _id: '$stageId',
          count: { $sum: 1 },
          valuePaise: { $sum: { $ifNull: ['$estimatedValuePaise', 0] } },
        },
      },
    ]),
    ...stages.map((stage) =>
      Opportunity.find({ $and: [filter, { stageId: stage._id }] })
        // Longest in the stage first: those are the ones that need a push.
        .sort({ stageEnteredAt: 1, _id: 1 })
        .limit(BOARD_COLUMN_LIMIT)
        .lean(),
    ),
  ]);
  const totalOf = new Map(totals.map((total) => [String(total._id), total]));
  const lookups = await loadLookups(cardsPerStage.flat());

  return stages.map((stage, index) => ({
    stage: {
      id: String(stage._id),
      name: stage.name,
      type: stage.type,
      color: stage.color ?? null,
    },
    count: totalOf.get(String(stage._id))?.count ?? 0,
    valuePaise: totalOf.get(String(stage._id))?.valuePaise ?? 0,
    leads: cardsPerStage[index].map((lead) => toListView(lead, lookups, actor)),
  }));
}

export async function getLead(actor, leadId) {
  return detailOf(await loadLeadForAction(actor, leadId, 'view'), actor);
}

/** The stages a lead has been through, newest first. */
export async function getLeadStageHistory(actor, leadId) {
  const lead = await loadLeadForAction(actor, leadId, 'view');
  const rows = await StageHistory.find({ opportunityId: lead._id })
    .sort({ changedAt: -1, _id: -1 })
    .lean();
  const ids = (pick) => uniqueIds(rows.flatMap(pick));
  const [stages, users] = await Promise.all([
    PipelineStage.find({ _id: { $in: ids((row) => [row.fromStageId, row.toStageId]) } })
      .select('name type')
      .lean(),
    User.find({ _id: { $in: ids((row) => [row.changedBy]) } })
      .select('name')
      .lean(),
  ]);
  const stageOf = new Map(stages.map((stage) => [String(stage._id), stage]));
  const userOf = new Map(users.map((user) => [String(user._id), user]));
  const stageView = (id) => {
    const stage = id && stageOf.get(String(id));
    return stage ? { id: String(stage._id), name: stage.name, type: stage.type } : null;
  };
  return rows.map((row) => ({
    id: String(row._id),
    from: stageView(row.fromStageId),
    to: stageView(row.toStageId),
    changedBy: named(userOf, row.changedBy),
    changedAt: row.changedAt,
    msInPreviousStage: row.msInPreviousStage ?? null,
    via: row.via ?? null,
  }));
}

/** What the lead form and the filters offer. */
export async function getLeadFormOptions(actor) {
  const canAssign = can(actor, 'assign', { feature: FEATURE });
  // People a lead can be given to: only someone who may assign gets the list.
  const userFilter = canAssign ? { status: 'active' } : { _id: actor._id };
  const [stages, statuses, categories, users] = await Promise.all([
    PipelineStage.find().sort({ order: 1, _id: 1 }).lean(),
    LeadStatus.find().sort({ order: 1, _id: 1 }).lean(),
    SolutionCategory.find().sort({ order: 1, _id: 1 }).lean(),
    User.find(userFilter).select('name').sort({ name: 1 }).lean(),
  ]);
  const option = (item) => ({ id: String(item._id), name: item.name, isActive: item.isActive });
  return {
    // Switched-off entries are included (marked), so a filter can still find leads that have one.
    stages: stages.map((stage) => ({
      ...option(stage),
      type: stage.type,
      color: stage.color ?? null,
      defaultProbability: stage.defaultProbability ?? null,
    })),
    leadStatuses: statuses.map((status) => ({
      ...option(status),
      color: status.color ?? null,
      isDefault: status.isDefault,
    })),
    solutionCategories: categories.map(option),
    users: users.map((user) => ({ id: String(user._id), name: user.name })),
    scopeLevels: SCOPE_LEVELS,
    feasibility: FEASIBILITY,
    budgetStatuses: BUDGET_STATUSES,
    riskLevels: RISK_LEVELS,
    buyingRoles: BUYING_ROLES,
    canAssign,
  };
}

// ── Writing ─────────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} actor
 * @param {object} data  Already validated (validation/opportunities.js createLeadBody)
 * @param {{ requestId?: string, via?: string }} [context]
 */
export async function createLead(actor, data, context = {}) {
  const { accountId, stageId, ownerId, assignedUserIds = [], leadStatusId, source, ...rest } = data;
  // A lead belongs to a company the person may see.
  const account = await loadAccountForAction(actor, accountId, 'view');

  // Naming another owner, adding people, or leaving it unassigned needs the "assign" permission.
  const givesAway =
    (ownerId !== undefined && !sameId(ownerId, actor._id)) || assignedUserIds.length;
  if (givesAway && !can(actor, 'assign', { feature: FEATURE })) {
    throw forbidden('You cannot choose the owner or assign people.');
  }
  await assertActiveUsers([ownerId], 'ownerId');
  await assertActiveUsers(assignedUserIds, 'assignedUserIds');
  await assertUsableLinks(account._id, { ...rest, leadStatusId });
  const stage = await startingStage(stageId);
  const chosenStatusId = leadStatusId ?? (await defaultLeadStatusId());

  const now = new Date();
  const fields = Object.fromEntries(
    Object.entries(rest).filter(([, value]) => value !== null && value !== undefined),
  );
  const document = {
    ...fields,
    // Taken last, after every check passed, so a refused request does not use up a code.
    leadCode: await nextCode(CODE_SERIES.lead),
    accountId: account._id,
    leadStatusId: chosenStatusId,
    stageId: stage._id,
    stageEnteredAt: now,
    status: 'open',
    probability: fields.probability ?? stage.defaultProbability,
    ownerId: ownerId === undefined ? actor._id : ownerId,
    assignedUserIds,
    source: source ?? 'manual',
    createdBy: actor._id,
    formFilledBy: actor._id,
  };

  // The lead and the first row of its stage history are saved together.
  let lead;
  await mongoose.connection.transaction(async (session) => {
    [lead] = await Opportunity.create([document], { session });
    await writeFirstStage(lead, actor, session, context.via);
  });

  await writeAudit({
    actor,
    action: 'lead.created',
    entityType: 'opportunities',
    entityId: lead._id,
    newValue: {
      leadCode: lead.leadCode,
      name: lead.name,
      accountId: String(account._id),
      ownerId: lead.ownerId ? String(lead.ownerId) : null,
    },
    requestId: context.requestId,
  });
  announce();
  return detailOf(lead.toObject(), actor);
}

/**
 * Change a lead: its own fields, who works on it, and (through the stage service) its stage.
 * A null value clears a field. The lead code and the company never change.
 * @param {object} changes  Already validated (validation/opportunities.js updateLeadBody)
 */
export async function updateLead(actor, leadId, changes, context = {}) {
  const lead = await loadLeadForAction(actor, leadId, 'edit');
  const {
    expectedUpdatedAt,
    overwrite,
    stageId,
    closeReason,
    lostToCompetitor,
    via,
    ...requested
  } = changes;

  // Someone else saved this lead after the form was opened: do not overwrite silently.
  if (expectedUpdatedAt && !overwrite && +expectedUpdatedAt !== +lead.updatedAt) {
    throw conflict('Someone else changed this lead while you were editing it.', [
      { code: 'STALE_DATA', message: 'The lead was changed by someone else.' },
    ]);
  }

  const plan = planChanges(lead, requested, { nested: NESTED_FIELDS });
  const peopleChanged = plan.fields.filter((field) => PEOPLE_FIELDS.includes(field));
  if (peopleChanged.length > 0) {
    if (!can(actor, 'assign', { feature: FEATURE, record: lead })) {
      throw forbidden('You cannot change the owner or the assigned people.');
    }
    if (plan.fields.includes('ownerId')) await assertActiveUsers([requested.ownerId], 'ownerId');
    if (plan.fields.includes('assignedUserIds')) {
      await assertActiveUsers(requested.assignedUserIds, 'assignedUserIds');
    }
  }
  if (plan.fields.includes('leadStatusId') && requested.leadStatusId === null) {
    throw fieldProblem('leadStatusId', 'A lead always has a status');
  }
  // Only what really changes is checked, so an old link (a status switched off since) may stay.
  await assertUsableLinks(
    lead.accountId,
    Object.fromEntries(plan.fields.map((field) => [field, plan.set[field]])),
  );

  // "No owner" is stored as null, not as a missing field (the unassigned filter looks for null).
  if ('ownerId' in plan.unset) {
    delete plan.unset.ownerId;
    plan.set.ownerId = null;
  }
  const update = toUpdate(plan);
  if (update) await Opportunity.updateOne({ _id: lead._id }, update, { runValidators: true });

  const otherChanged = plan.fields.filter((field) => !PEOPLE_FIELDS.includes(field));
  const pick = (source, fields) =>
    Object.fromEntries(fields.map((field) => [field, source[field]]));
  const base = {
    actor,
    entityType: 'opportunities',
    entityId: lead._id,
    requestId: context.requestId,
  };
  if (otherChanged.length > 0) {
    await writeAudit({
      ...base,
      action: 'lead.updated',
      oldValue: pick(plan.oldValue, otherChanged),
      newValue: pick(plan.newValue, otherChanged),
    });
  }
  if (peopleChanged.length > 0) {
    await writeAudit({
      ...base,
      action: 'lead.assignment_changed',
      oldValue: pick(plan.oldValue, peopleChanged),
      newValue: pick(plan.newValue, peopleChanged),
    });
  }

  // The stage goes through the one stage service, also when it is changed in the edit form.
  let stageChanged = false;
  if (stageId) {
    const moved = await moveToStage(
      actor,
      lead,
      { stageId, closeReason, lostToCompetitor, via: via ?? 'edit_form' },
      context,
    );
    stageChanged = moved.changed;
  }

  if (update || stageChanged) announce();
  return detailOf(await Opportunity.findById(lead._id).lean(), actor);
}

/**
 * Move a lead to another stage (the pipeline board, the stage bar of the lead page).
 * @param {{ stageId: string, closeReason?: string, lostToCompetitor?: string, via?: string }} data
 */
export async function changeLeadStage(actor, leadId, data, context = {}) {
  const lead = await loadLeadForAction(actor, leadId, 'edit');
  const moved = await moveToStage(actor, lead, data, context);
  if (moved.changed) announce();
  return detailOf(await Opportunity.findById(lead._id).lean(), actor);
}

/** Soft delete: the lead disappears from every screen; its history and its code stay. */
export async function deleteLead(actor, leadId, context = {}) {
  const lead = await loadLeadForAction(actor, leadId, 'delete');
  await Opportunity.updateOne(
    { _id: lead._id },
    { $set: { deletedAt: new Date(), deletedBy: actor._id } },
  );
  await writeAudit({
    actor,
    action: 'lead.deleted',
    entityType: 'opportunities',
    entityId: lead._id,
    oldValue: { leadCode: lead.leadCode, name: lead.name },
    requestId: context.requestId,
  });
  announce();
}

// A company with leads that are still open cannot be deleted (close or delete the leads first).
registerAccountDeleteBlocker(async (accountId) => {
  const open = await Opportunity.countDocuments({ accountId, status: 'open', ...NOT_DELETED });
  return open > 0 ? `It has ${open} open ${open === 1 ? 'lead' : 'leads'}.` : null;
});
