import { AI_DAILY_REFRESH } from '../ai/config.js';
import { getAiSettings, isAiReady } from '../ai/settings.js';
import { assessLead } from '../ai/tasks/assessLead.js';
import { summarizeAccount } from '../ai/tasks/summarizeAccount.js';
import { JOB_NAMES } from '../constants/jobNames.js';
import { logger } from '../infra/logger.js';
import { enqueue } from '../infra/queues.js';
import { writeAudit } from '../lib/audit.js';
import { can } from '../lib/can.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { scopeFilter } from '../lib/scopeFilter.js';
import { systemActor } from '../lib/systemActor.js';
import { Activity } from '../models/activity.model.js';
import { AiFeedback } from '../models/aiFeedback.model.js';
import { AiInsight } from '../models/aiInsight.model.js';
import { AiRun } from '../models/aiRun.model.js';
import { Account } from '../models/account.model.js';
import { Contact } from '../models/contact.model.js';
import { Opportunity } from '../models/opportunity.model.js';
import { PipelineStage } from '../models/pipelineStage.model.js';
import { Task } from '../models/task.model.js';
import { User } from '../models/user.model.js';
import { loadAccountForAction } from './accounts.service.js';
import { loadLeadForAction } from './opportunities.service.js';
import { createTask } from './tasks.service.js';

// AI insights about one record: the summary of a company, and the score and next best action
// of a lead. This file decides WHAT the AI is shown (only records the asking person may see),
// keeps the newest answer, takes people's opinion of it, and keeps it up to date.
// The model call itself is an AI task (server/ai/tasks/).
//
// An insight is text to read. Nothing here changes a company or a lead, except the lead's two
// derived fields `aiScore` and `aiRiskLevel`, which are a saved copy of the newest assessment.
// The one thing a person can turn an insight into is a task, through the normal task service.

const NOT_DELETED = { deletedAt: null };
const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_ENTRIES = 20;
const NOTE_CHARACTERS = 400;
const OPEN_TASK = ['open', 'in_progress'];
// An insight counts as out of date when the record got news this long after it was written.
const STALE_AFTER_MS = 60 * 1000;
// The system does not ask the AI again about the same record more often than this.
const AUTO_REFRESH_GAP_MS = 20 * 60 * 1000;

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

/**
 * What a screen gets: the insight, whether the record changed since, and my own opinion of it.
 * @param {object} filter  Finds the one insight
 * @param {object} actor
 * @param {unknown} recordChangedAt  The record's "last activity" time
 */
async function viewOf(filter, actor, recordChangedAt) {
  const insight = await AiInsight.findOne(filter).lean();
  if (!insight) return { isAiReady: isAiReady(), insight: null };
  const [user, feedback] = await Promise.all([
    insight.generatedBy ? User.findById(insight.generatedBy).select('name').lean() : null,
    actor._id ? AiFeedback.findOne({ aiRunId: insight.aiRunId, userId: actor._id }).lean() : null,
  ]);
  return {
    isAiReady: isAiReady(),
    insight: {
      id: String(insight._id),
      content: insight.content,
      model: insight.model ?? null,
      generatedAt: insight.generatedAt,
      // Empty when the system refreshed it by itself.
      generatedBy: user?.name ?? null,
      isStale:
        Boolean(recordChangedAt) &&
        new Date(recordChangedAt) - new Date(insight.generatedAt) > STALE_AFTER_MS,
      myFeedback: feedback
        ? {
            verdict: feedback.verdict,
            note: feedback.note ?? null,
            taskId: feedback.taskId ? String(feedback.taskId) : null,
          }
        : null,
    },
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
        generatedBy: actor._id ?? null,
      },
    },
    { upsert: true },
  );
}

// ── A company's summary ─────────────────────────────────────────────────────────────────────

/**
 * The leads of a company that this person may see, and who the resulting summary is for:
 * "all" when they see every lead of it, else only themselves.
 */
async function visibleLeads(actor, accountId) {
  const ofAccount = { accountId, ...NOT_DELETED };
  const mine = { $and: [ofAccount, scopeFilter(actor, 'opportunities')] };
  const [total, seen, leads] = await Promise.all([
    Opportunity.countDocuments(ofAccount),
    Opportunity.countDocuments(mine),
    Opportunity.find(mine).sort({ createdAt: -1 }).limit(15).lean(),
  ]);
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
  return viewOf(accountFilter(account._id, audience), actor, account.lastActivityAt);
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
    userId: actor._id ?? undefined,
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
  const filter = accountFilter(account._id, audience);
  await keep(filter, result, actor);
  return viewOf(filter, actor, account.lastActivityAt);
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
  return viewOf(leadFilter(lead._id), actor, lead.lastActivityAt);
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
    userId: actor._id ?? undefined,
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

  // A saved copy on the lead, so lists and the board can show it without asking the AI again.
  await Opportunity.updateOne(
    { _id: lead._id },
    { $set: { aiScore: result.output.score, aiRiskLevel: result.output.riskLevel } },
    { timestamps: false },
  );
  const filter = leadFilter(lead._id);
  await keep(filter, result, actor);
  return viewOf(filter, actor, lead.lastActivityAt);
}

// ── What people think of an answer ──────────────────────────────────────────────────────────

/**
 * One insight, for someone who may read it: they may see its record, and it was written for
 * them (a company summary built from all leads is only for people who see all those leads).
 * @returns {Promise<{ insight: object, filter: object, recordChangedAt: unknown }>}
 */
async function loadInsightFor(actor, insightId) {
  const insight = await AiInsight.findById(insightId).lean();
  if (!insight) throw notFound('This AI answer does not exist any more.');
  const filter = {
    kind: insight.kind,
    entityType: insight.entityType,
    entityId: insight.entityId,
    audience: insight.audience,
  };
  if (insight.entityType === 'accounts') {
    const account = await loadAccountForAction(actor, insight.entityId, 'view');
    const { audience } = await visibleLeads(actor, account._id);
    if (audience !== insight.audience) throw notFound('This AI answer does not exist any more.');
    return { insight, filter, recordChangedAt: account.lastActivityAt };
  }
  const lead = await loadLeadForAction(actor, insight.entityId, 'view');
  return { insight, filter, recordChangedAt: lead.lastActivityAt };
}

async function saveFeedback(actor, insight, fields) {
  const run = await AiRun.findById(insight.aiRunId).select('task').lean();
  await AiFeedback.findOneAndUpdate(
    { aiRunId: insight.aiRunId, userId: actor._id },
    { $set: { task: run?.task ?? insight.kind, ...fields } },
    { upsert: true },
  );
}

/**
 * Say what you think of an AI answer: useful, not useful, or what it should have said.
 * @param {{ verdict: 'accepted' | 'rejected' | 'edited', note?: string }} opinion  Validated
 */
export async function giveFeedback(actor, insightId, { verdict, note }) {
  const { insight, filter, recordChangedAt } = await loadInsightFor(actor, insightId);
  await saveFeedback(actor, insight, { verdict, note: note || undefined });
  return viewOf(filter, actor, recordChangedAt);
}

/**
 * Turn the next best action of a lead's assessment into a task for me, through the normal
 * task service (so my permissions and the lead access rule apply). Counts as "useful".
 */
export async function acceptNextAction(actor, insightId, context = {}) {
  const { insight, filter, recordChangedAt } = await loadInsightFor(actor, insightId);
  const step = insight.content?.nextBestAction;
  if (insight.kind !== 'lead_assessment' || !step) {
    throw conflict('This AI answer has no next step to turn into a task.');
  }
  if (!can(actor, 'create', { feature: 'tasks' })) {
    throw forbidden('You do not have permission to add tasks.');
  }
  const mine = await AiFeedback.findOne({ aiRunId: insight.aiRunId, userId: actor._id }).lean();
  if (mine?.taskId) throw conflict('You already made a task from this suggestion.');

  const task = await createTask(
    actor,
    {
      title: step.action.slice(0, 200),
      description: `Suggested by AI. Why: ${step.reason}`,
      type: 'follow_up',
      opportunityId: String(insight.entityId),
      dueAt: new Date(Date.now() + 2 * DAY_MS),
    },
    { requestId: context.requestId, origin: { source: 'ai' } },
  );
  // A correction the person wrote before stays a correction.
  const verdict = mine?.verdict === 'edited' ? 'edited' : 'accepted';
  await saveFeedback(actor, insight, { verdict, taskId: task.id });
  await writeAudit({
    actor,
    action: 'ai.suggestion_accepted',
    entityType: 'opportunities',
    entityId: insight.entityId,
    newValue: { taskId: task.id, aiRunId: String(insight.aiRunId) },
    requestId: context.requestId,
  });
  return viewOf(filter, actor, recordChangedAt);
}

// ── Keeping insights up to date by themselves ───────────────────────────────────────────────

/**
 * The background job after something happened on a record: ask the AI again, as the system.
 * Only for an insight somebody asked for before, only for an open lead, only when the setting
 * allows it, and never more often than every 20 minutes for one record. Safe to run twice.
 * @param {{ kind: 'lead' | 'account', id: string }} target
 * @returns {Promise<string>} What was done, for the job log
 */
export async function autoRefreshInsight({ kind, id }) {
  if (!isAiReady() || !(await getAiSettings()).autoRefresh) return 'switched off';
  const filter = kind === 'lead' ? leadFilter(id) : accountFilter(id, 'all');
  const insight = await AiInsight.findOne(filter).select('generatedAt').lean();
  if (!insight) return 'nobody asked for this one yet';
  if (Date.now() - new Date(insight.generatedAt) < AUTO_REFRESH_GAP_MS) return 'fresh enough';
  try {
    if (kind === 'lead') {
      const lead = await Opportunity.findOne({ _id: id, ...NOT_DELETED })
        .select('status')
        .lean();
      if (lead?.status !== 'open') return 'the lead is closed';
      await refreshLeadAssessment(systemActor(), id);
    } else {
      await refreshAccountSummary(systemActor(), id);
    }
    return 'refreshed';
  } catch (error) {
    // The budget is used up, or the record is gone: not a reason to try again.
    if (error?.isAppError) {
      logger.info({ kind, id, reason: error.message }, 'AI insight not refreshed');
      return 'skipped';
    }
    throw error;
  }
}

/**
 * The records whose AI answer has grown old: open leads after 3 days, companies after 7.
 * Oldest first, and no more than the daily number.
 * @param {Date} [now]
 * @returns {Promise<{ kind: 'lead' | 'account', id: string }[]>}
 */
export async function findInsightsToRefresh(now = new Date()) {
  const before = (days) => new Date(now.getTime() - days * DAY_MS);
  const [leadInsights, accountInsights] = await Promise.all([
    AiInsight.find({
      kind: 'lead_assessment',
      generatedAt: { $lt: before(AI_DAILY_REFRESH.leadAfterDays) },
    })
      .select('entityId')
      .sort({ generatedAt: 1 })
      .lean(),
    AiInsight.find({
      kind: 'account_summary',
      audience: 'all',
      generatedAt: { $lt: before(AI_DAILY_REFRESH.accountAfterDays) },
    })
      .select('entityId')
      .sort({ generatedAt: 1 })
      .limit(AI_DAILY_REFRESH.maxAccounts)
      .lean(),
  ]);
  // A closed or deleted lead is not worth asking about again.
  const open = await Opportunity.find({
    _id: { $in: leadInsights.map((insight) => insight.entityId) },
    status: 'open',
    ...NOT_DELETED,
  })
    .select('_id')
    .lean();
  const isOpen = new Set(open.map((lead) => String(lead._id)));
  return [
    ...leadInsights
      .map((insight) => String(insight.entityId))
      .filter((id) => isOpen.has(id))
      .slice(0, AI_DAILY_REFRESH.maxLeads)
      .map((id) => ({ kind: 'lead', id })),
    ...accountInsights.map((insight) => ({ kind: 'account', id: String(insight.entityId) })),
  ];
}

/**
 * The morning job: put one refresh job per old insight on the `ai` queue (two run at a time,
 * so the budget is not spent in a burst). Safe to run twice: a record is queued once per day.
 * @returns {Promise<{ queued: number }>}
 */
export async function queueDailyRefresh(now = new Date()) {
  if (!isAiReady() || !(await getAiSettings()).autoRefresh) return { queued: 0 };
  const targets = await findInsightsToRefresh(now);
  const dayKey = now.toISOString().slice(0, 10);
  for (const { kind, id } of targets) {
    await enqueue(
      'ai',
      JOB_NAMES.insightRefresh,
      { kind, id },
      { jobId: `insight-${kind}-${id}-daily-${dayKey}` },
    );
  }
  return { queued: targets.length };
}
