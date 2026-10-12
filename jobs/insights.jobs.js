import { autoRefreshInsight, queueDailyRefresh } from '../services/insights.service.js';

/** Every morning: queue a refresh for the AI answers that have grown old. */
export async function runInsightDailyJob() {
  return queueDailyRefresh();
}

/**
 * Something happened on a lead or a company that has an AI insight: ask the AI again.
 * Safe to run twice: a second run finds the insight fresh and does nothing.
 * @param {{ kind: 'lead' | 'account', id: string }} data
 */
export async function runInsightRefreshJob(data) {
  return { result: await autoRefreshInsight(data) };
}
