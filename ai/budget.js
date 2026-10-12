import { logger } from '../infra/logger.js';
import { AiUsageDaily, AiUsageMonthly } from '../models/aiUsage.model.js';
import { notifySettingsManagers } from '../services/notifications.service.js';
import { AI_USD_TO_INR } from './config.js';
import { getAiSettings } from './settings.js';

// The two locks on AI spending: a monthly cap in rupees for the whole company, and a number of
// runs per person per day. Checked before every model call and counted after it, by
// runAiTask(). When a lock is closed the AI refuses with a clear message; the CRM keeps working.
// The cap, the daily number and the alert percentage are settings (Settings → AI).

// India time is UTC + 5:30, the whole year.
const INDIA_OFFSET_MS = 5.5 * 60 * 60 * 1000;
export const indiaDay = (moment) =>
  new Date(moment.getTime() + INDIA_OFFSET_MS).toISOString().slice(0, 10);
export const indiaMonth = (moment) => indiaDay(moment).slice(0, 7);

/** US dollars (the provider's cost figure) → paise, rounded up so spend is never undercounted. */
export const usdToPaise = (usd) => Math.ceil(Number(usd || 0) * AI_USD_TO_INR * 100);

/**
 * May one more AI run start?
 * @param {{ userId?: unknown, now?: Date }} who  userId is empty for runs the system starts
 * @returns {Promise<{ allowed: true } |
 *                   { allowed: false, status: 'blocked_cap' | 'blocked_limit', message: string }>}
 */
export async function checkBudget({ userId, now = new Date() } = {}) {
  const limits = await getAiSettings();
  const month = await AiUsageMonthly.findOne({ month: indiaMonth(now) })
    .select('totalCostPaise')
    .lean();
  if ((month?.totalCostPaise ?? 0) >= limits.monthlyCapPaise) {
    return {
      allowed: false,
      status: 'blocked_cap',
      message: 'The AI budget for this month is used up. It starts again next month.',
    };
  }
  if (userId) {
    const day = await AiUsageDaily.findOne({ userId, day: indiaDay(now) })
      .select('count')
      .lean();
    if ((day?.count ?? 0) >= limits.dailyRunsPerUser) {
      return {
        allowed: false,
        status: 'blocked_limit',
        message: 'You have used all your AI requests for today. Try again tomorrow.',
      };
    }
  }
  return { allowed: true };
}

/**
 * Count one finished model call against the two locks, and tell the people who manage the
 * settings once when the alert percentage of the cap is used and once when all of it is.
 * @param {{ task: string, costPaise: number, userId?: unknown, now?: Date }} run
 */
export async function recordUsage({ task, costPaise, userId, now = new Date() }) {
  const limits = await getAiSettings();
  const month = indiaMonth(now);
  const usage = await AiUsageMonthly.findOneAndUpdate(
    { month },
    {
      $inc: {
        totalCostPaise: costPaise,
        runs: 1,
        [`byTask.${task}.costPaise`]: costPaise,
        [`byTask.${task}.runs`]: 1,
      },
      $set: { capPaise: limits.monthlyCapPaise },
    },
    { upsert: true, returnDocument: 'after' },
  ).lean();
  if (userId) {
    await AiUsageDaily.updateOne(
      { userId, day: indiaDay(now) },
      { $inc: { count: 1 } },
      { upsert: true },
    );
  }

  const rupees = (paise) => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;
  const steps = [
    {
      field: 'capReachedAt',
      reached: usage.totalCostPaise >= limits.monthlyCapPaise,
      title: 'The AI budget for this month is used up',
      body: `${rupees(limits.monthlyCapPaise)} is spent. AI features are paused until next month, or until the budget is raised.`,
    },
    {
      // (The field kept its first name; the percentage is a setting now.)
      field: 'alert80SentAt',
      reached: usage.totalCostPaise >= (limits.monthlyCapPaise * limits.alertPercent) / 100,
      title: `The AI budget for this month is ${limits.alertPercent}% used`,
      body: `${rupees(usage.totalCostPaise)} of ${rupees(limits.monthlyCapPaise)} is spent.`,
    },
  ];
  for (const step of steps) {
    if (!step.reached || usage[step.field]) continue;
    // Only the run that sets the mark tells.
    const marked = await AiUsageMonthly.updateOne(
      { month, [step.field]: null },
      { $set: { [step.field]: now } },
    );
    if (marked.modifiedCount === 0) continue;
    await notifySettingsManagers({
      type: 'ai_budget',
      title: step.title,
      body: step.body,
      link: '/settings?section=ai',
      // Per budget and warning level: after a change in Settings the warning can come again.
      dedupeKey: `ai-budget:${month}:${step.field}:${limits.monthlyCapPaise}:${limits.alertPercent}`,
    }).catch((error) => logger.warn({ err: error }, 'Could not tell about the AI budget'));
  }
}
