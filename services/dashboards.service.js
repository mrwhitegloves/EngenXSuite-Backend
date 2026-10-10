import { can } from '../lib/can.js';
import { resolveDateRange } from '../lib/dateRange.js';
import { scopeFilter } from '../lib/scopeFilter.js';
import { Account } from '../models/account.model.js';
import { Opportunity } from '../models/opportunity.model.js';
import { PipelineStage } from '../models/pipelineStage.model.js';
import { User } from '../models/user.model.js';
import { countMyTasks, listTasks } from './tasks.service.js';

// The dashboard's "today" blocks: what the signed-in person should look at now.
// Everything is read through the same scopes as the lists, so the dashboard never shows a lead
// or a task the person may not see (decision 0008).

const NOT_DELETED = { deletedAt: null };
const LIST_LIMIT = 8;
const DAY_MS = 24 * 60 * 60 * 1000;
// "Closing soon" looks this many days ahead.
export const CLOSING_SOON_DAYS = 14;

/** Leads as the dashboard lists show them. */
async function toLeadRows(leads) {
  const ids = (field) => [...new Set(leads.map((lead) => lead[field]).filter(Boolean))];
  const [accounts, stages, owners] = await Promise.all([
    Account.find({ _id: { $in: ids('accountId') } })
      .select('name')
      .lean(),
    PipelineStage.find({ _id: { $in: ids('stageId') } })
      .select('name')
      .lean(),
    User.find({ _id: { $in: ids('ownerId') } })
      .select('name')
      .lean(),
  ]);
  const nameOf = (list, id) => list.find((item) => String(item._id) === String(id))?.name ?? null;
  return leads.map((lead) => ({
    id: String(lead._id),
    leadCode: lead.leadCode,
    name: lead.name,
    accountName: nameOf(accounts, lead.accountId),
    stageName: nameOf(stages, lead.stageId),
    ownerName: nameOf(owners, lead.ownerId),
    estimatedValuePaise: lead.estimatedValuePaise ?? null,
    expectedCloseDate: lead.expectedCloseDate ?? null,
    nextAction: lead.nextAction ?? null,
  }));
}

/**
 * @param {object} actor
 * @param {Date} [now]  Only tests pass it
 */
export async function getTodayDashboard(actor, now = new Date()) {
  const seesTasks = can(actor, 'view', { feature: 'tasks' });
  const seesLeads = can(actor, 'view', { feature: 'opportunities' });
  const today = resolveDateRange({ range: 'today' }, now);
  const result = { tasks: null, leads: null };

  if (seesTasks) {
    // My own tasks, whatever else my permission would show.
    const mine = { assigneeId: String(actor._id), page: 1, pageSize: LIST_LIMIT };
    const [counts, dueToday, overdue] = await Promise.all([
      countMyTasks(actor, now),
      listTasks(actor, { ...mine, view: 'today' }, now),
      listTasks(actor, { ...mine, view: 'overdue' }, now),
    ]);
    result.tasks = { counts, today: dueToday.items, overdue: overdue.items };
  }

  if (seesLeads) {
    const open = { $and: [scopeFilter(actor, 'opportunities'), NOT_DELETED, { status: 'open' }] };
    const closingBefore = new Date(today.to.getTime() + CLOSING_SOON_DAYS * DAY_MS);
    const [totals, needAction, closingSoon, unassigned] = await Promise.all([
      Opportunity.aggregate([
        { $match: open },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            valuePaise: { $sum: { $ifNull: ['$estimatedValuePaise', 0] } },
          },
        },
      ]),
      // The next action is due today or was due earlier.
      Opportunity.find({ $and: [open, { 'nextAction.dueAt': { $lt: today.to } }] })
        .sort({ 'nextAction.dueAt': 1 })
        .limit(LIST_LIMIT)
        .lean(),
      Opportunity.find({ $and: [open, { expectedCloseDate: { $lt: closingBefore } }] })
        .sort({ expectedCloseDate: 1 })
        .limit(LIST_LIMIT)
        .lean(),
      // Leads nobody owns yet: a number for the people who assign them.
      can(actor, 'assign', { feature: 'opportunities' })
        ? Opportunity.countDocuments({ $and: [open, { ownerId: null }] })
        : null,
    ]);
    result.leads = {
      openCount: totals[0]?.count ?? 0,
      openValuePaise: totals[0]?.valuePaise ?? 0,
      unassignedCount: unassigned,
      needAction: await toLeadRows(needAction),
      closingSoon: await toLeadRows(closingSoon),
    };
  }
  return result;
}
