import { isAiReady } from '../ai/settings.js';
import { assessLead } from '../ai/tasks/assessLead.js';
import { summarizeAccount } from '../ai/tasks/summarizeAccount.js';
import { scopeFilter } from '../lib/scopeFilter.js';
import { Activity } from '../models/activity.model.js';
import { AiInsight } from '../models/aiInsight.model.js';
import { Account } from '../models/account.model.js';
import { Contact } from '../models/contact.model.js';
import { Opportunity } from '../models/opportunity.model.js';
import { PipelineStage } from '../models/pipelineStage.model.js';
import { Task } from '../models/task.model.js';
import { User } from '../models/user.model.js';
import { loadAccountForAction } from './accounts.service.js';
import { loadLeadForAction } from './opportunities.service.js';

// AI insights about one record: the summary of a company, and the score and next best action
// of a lead. This file decides WHAT the AI is shown (only records the asking person may see)
// and keeps the newest answer; the model call itself is an AI task (server/ai/tasks/).
//
// An insight is text to read. Nothing here changes a company or a lead, except the lead's two
// derived fields `aiScore` and `aiRiskLevel`, which are a saved copy of the newest assessment.

const NOT_DELETED = { deletedAt: null };
const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_ENTRIES = 20;
const NOTE_CHARACTERS = 400;
const OPEN_TASK = ['open', 'in_progress'];

const rupees = (paise) => (typeof paise === 'number' ? Math.round(paise / 100) : undefined);
const day = (value) => (value ? new Date(value).toISOString().slice(0, 10) : undefined);
const daysSince = (value, now) =>
  value ? Math.max(0, Math.floor((now - new Date(value)) / DAY_MS)) : undefined;
/** Leaves out empty values, so the prompt holds only what is known. */
const known = (object) =>
  Object.fromEntries(
    Object.entries(object).filter(
      ([, value]) =>
        value !== undefined &&
        value !== null &&
        value !== '' &&
        !(Array.isArray(value) && value.length === 0),
    ),
  );

async function stageNames(leads) {
  const stages = await PipelineStage.find({ _id: { $in: leads.map((lead) => lead.stageId) } })
    .select('name')
    .lean();
  return new Map(stages.map((stage) => [String(stage._id), stage.name]));
}

const historyOf = (activities) =>
  activities.map((activity) =>
    known({
      date: day(activity.occurredAt),
      kind: activity.type,
      direction: activity.direction,
      title: activity.title,
      text: activity.content?.slice(0, NOTE_CHARACTERS),
    }),
  );

const tasksOf = (tasks, now) =>
  tasks.map((task) =>
    known({
      title: task.title,
      kind: task.type,
      priority: task.priority,
      due: day(task.dueAt),
      isOverdue: task.dueAt ? new Date(task.dueAt) < now : undefined,
    }),
  );

function leadFacts(lead, stages, now) {
  return known({
    name: lead.name,
    status: lead.status,
    stage: stages.get(String(lead.stageId)),
    daysInThisStage: daysSince(lead.stageEnteredAt, now),
    daysSinceLastActivity: daysSince(lead.lastActivityAt, now),
    valueRupees: rupees(lead.estimatedValuePaise),
    chancePercent: lead.probability,
    expectedClose: day(lead.expectedCloseDate),
    requirement: lead.requirement,
    problem: lead.problemStatement,
    expectedImpact: lead.expectedImpact,
    budget: lead.budgetStatus,
    feasibility: lead.technicalFeasibility,
    decisionTimeline: lead.decisionTimeline,
    competitor: lead.competitor,
    nextStep: lead.nextAction?.text,
    nextStepDue: day(lead.nextAction?.dueAt),
    riskSeenBySales: lead.risk?.level,
    riskNote: lead.risk?.note,
    source: lead.source,
    createdOn: day(lead.createdAt),
  });
}

const personFacts = (contact, now) =>
  known({
    name: contact.name,
    designation: contact.designation,
    department: contact.department,
    roleInDecisions: contact.stakeholderRole,
    decisionPower1to5: contact.decisionPower,
    ourRelationship1to5: contact.relationshipStrength,
    daysSinceWeTalked: daysSince(contact.lastInteractionAt, now),
  });

function accountFacts(account) {
  return known({
    name: account.name,
    industry: account.industry,
    companyType: account.companyType,
    city: account.hq?.city ?? account.city,
    size: account.companySize,
    about: account.description,
    ...known(account.industrial ?? {}),
    potential: account.commercial?.accountPotential,
    relationshipHealth: account.commercial?.relationshipHealth,
    strategicImportance1to5: account.commercial?.strategicImportance,
  });
}

function toView(insight, names) {
  if (!insight) return null;
  return {
    id: String(insight._id),
    content: insight.content,
    model: insight.model ?? null,
    generatedAt: insight.generatedAt,
    generatedBy: names.get(String(insight.generatedBy)) ?? null,
    aiRunId: String(insight.aiRunId),
  };
}

async function viewOf(filter) {
  const insight = await AiInsight.findOne(filter).lean();
  const user = insight?.generatedBy
    ? await User.findById(insight.generatedBy).select('name').lean()
    : null;
  return {
    isAiReady: isAiReady(),
    insight: toView(insight, new Map(user ? [[String(user._id), user.name]] : [])),
  };
}

async function keep(filter, result, actor) {
  await AiInsight.findOneAndUpdate(
    filter,
    {
      $set: {
        content: result.output,
        aiRunId: result.runId,
        model: result.model,
        generatedAt: new Date(),
        generatedBy: actor._id,
      },
    },
    { upsert: true },
  );
  return viewOf(filter);
}

// ── A company's summary ─────────────────────────────────────────────────────────────────────

/**
 * The leads of a company that this person may see, and who the resulting summary is for:
 * "all" when they see every lead of it, else only themselves.
 */
async function visibleLeads(actor, accountId) {
  const ofAccount = { accountId, ...NOT_DELETED };
  const [total, leads] = await Promise.all([
    Opportunity.countDocuments(ofAccount),
    Opportunity.find({ $and: [ofAccount, scopeFilter(actor, 'opportunities')] })
      .sort({ createdAt: -1 })
      .limit(15)
      .lean(),
  ]);
  const seen = await Opportunity.countDocuments({
    $and: [ofAccount, scopeFilter(actor, 'opportunities')],
  });
  return { leads, audience: seen === total ? 'all' : `user:${actor._id}` };
}

const accountFilter = (accountId, audience) => ({
  kind: 'account_summary',
  entityType: 'accounts',
  entityId: accountId,
  audience,
});

/** The saved summary of a company, for someone who may see the company. */
export async function getAccountSummary(actor, accountId) {
  const account = await loadAccountForAction(actor, accountId, 'view');
  const { audience } = await visibleLeads(actor, account._id);
  return viewOf(accountFilter(account._id, audience));
}

/** Ask the AI for a new summary of a company, from what this person may see of it. */
export async function refreshAccountSummary(actor, accountId) {
  const account = await loadAccountForAction(actor, accountId, 'view');
  const now = new Date();
  const { leads, audience } = await visibleLeads(actor, account._id);
  const leadIds = leads.map((lead) => lead._id);
  // History and tasks of the company itself, and of the leads this person may see.
  const reachable = { $or: [{ opportunityId: null }, { opportunityId: { $in: leadIds } }] };
  const [contacts, activities, tasks, stages] = await Promise.all([
    Contact.find({ accountId: account._id, ...NOT_DELETED })
      .sort({ decisionPower: -1, createdAt: 1 })
      .limit(15)
      .lean(),
    Activity.find({ accountId: account._id, ...reachable })
      .sort({ occurredAt: -1 })
      .limit(HISTORY_ENTRIES)
      .lean(),
    Task.find({ accountId: account._id, status: { $in: OPEN_TASK }, ...reachable })
      .sort({ dueAt: 1 })
      .limit(10)
      .lean(),
    stageNames(leads),
  ]);

  const result = await summarizeAccount({
    accountId: account._id,
    userId: actor._id,
    inputRefs: [
      { kind: 'accounts', id: account._id },
      ...leadIds.map((id) => ({ kind: 'opportunities', id })),
    ],
    context: {
      today: day(now),
      company: accountFacts(account),
      people: contacts.map((contact) => personFacts(contact, now)),
      leads: leads.map((lead) => leadFacts(lead, stages, now)),
      openTasks: tasksOf(tasks, now),
      recentHistory: historyOf(activities),
    },
  });
  return keep(accountFilter(account._id, audience), result, actor);
}

// ── A lead's score and next best action ─────────────────────────────────────────────────────

const leadFilter = (leadId) => ({
  kind: 'lead_assessment',
  entityType: 'opportunities',
  entityId: leadId,
  audience: 'all',
});

/** The saved assessment of a lead, for someone who may see the lead. */
export async function getLeadAssessment(actor, leadId) {
  const lead = await loadLeadForAction(actor, leadId, 'view');
  return viewOf(leadFilter(lead._id));
}

/** Ask the AI to assess a lead again. */
export async function refreshLeadAssessment(actor, leadId) {
  const lead = await loadLeadForAction(actor, leadId, 'view');
  const now = new Date();
  const contactIds = [
    lead.primaryContactId,
    ...(lead.stakeholders ?? []).map((item) => item.contactId),
  ].filter(Boolean);
  const [account, contacts, activities, tasks, stages] = await Promise.all([
    Account.findById(lead.accountId).lean(),
    Contact.find({ _id: { $in: contactIds }, ...NOT_DELETED }).lean(),
    Activity.find({ opportunityId: lead._id })
      .sort({ occurredAt: -1 })
      .limit(HISTORY_ENTRIES)
      .lean(),
    Task.find({ opportunityId: lead._id }).sort({ dueAt: 1 }).limit(15).lean(),
    stageNames([lead]),
  ]);
  const main = contacts.find((contact) => String(contact._id) === String(lead.primaryContactId));

  const result = await assessLead({
    leadId: lead._id,
    userId: actor._id,
    inputRefs: [
      { kind: 'opportunities', id: lead._id },
      ...(account ? [{ kind: 'accounts', id: account._id }] : []),
    ],
    context: {
      today: day(now),
      lead: leadFacts(lead, stages, now),
      company: account ? accountFacts(account) : undefined,
      mainContact: main ? personFacts(main, now) : undefined,
      otherPeople: contacts.filter((contact) => contact !== main).map((c) => personFacts(c, now)),
      openTasks: tasksOf(
        tasks.filter((task) => OPEN_TASK.includes(task.status)),
        now,
      ),
      tasksDone: tasks.filter((task) => task.status === 'done').length,
      history: historyOf(activities),
    },
  });

  // A saved copy on the lead, so lists can show and sort by it without asking the AI again.
  await Opportunity.updateOne(
    { _id: lead._id },
    { $set: { aiScore: result.output.score, aiRiskLevel: result.output.riskLevel } },
    { timestamps: false },
  );
  return keep(leadFilter(lead._id), result, actor);
}
