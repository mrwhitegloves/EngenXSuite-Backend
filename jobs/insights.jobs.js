import { autoRefreshInsight } from '../services/insights.service.js';

/**
 * Something happened on a lead or a company that has an AI insight: ask the AI again.
 * Safe to run twice: a second run finds the insight fresh and does nothing.
 * @param {{ kind: 'lead' | 'account', id: string }} data
 */
export async function runInsightRefreshJob(data) {
  return { result: await autoRefreshInsight(data) };
}
