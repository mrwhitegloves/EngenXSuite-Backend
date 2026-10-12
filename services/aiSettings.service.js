import { indiaMonth } from '../ai/budget.js';
import {
  AI_MODEL_CHOICES,
  AI_MODEL_CLASSES,
  AI_MODEL_CLASS_KEYS,
  AI_USD_TO_INR,
} from '../ai/config.js';
import { getAiSettings, isAiReady } from '../ai/settings.js';
import { writeAudit } from '../lib/audit.js';
import { badRequest } from '../lib/errors.js';
import { AiUsageMonthly } from '../models/aiUsage.model.js';
import { Settings } from '../models/settings.model.js';

// Settings → AI: the monthly budget, the runs per person per day, when to warn, which model
// does which class of work, and what was spent this month.

/** What Settings → AI shows. */
export async function getAiSettingsView(now = new Date()) {
  const [settings, usage] = await Promise.all([
    getAiSettings(),
    AiUsageMonthly.findOne({ month: indiaMonth(now) }).lean(),
  ]);
  return {
    isAiReady: isAiReady(),
    monthlyCapPaise: settings.monthlyCapPaise,
    dailyRunsPerUser: settings.dailyRunsPerUser,
    alertPercent: settings.alertPercent,
    // One line per class of work: what it is for, and the two models chosen for it.
    classes: AI_MODEL_CLASS_KEYS.map((key) => ({
      key,
      label: AI_MODEL_CLASSES[key].label,
      usedFor: AI_MODEL_CLASSES[key].usedFor,
      model: settings.models[key].model,
      fallback: settings.models[key].fallback,
    })),
    // The models that can be chosen, with their price per 1 million tokens in rupees.
    choices: AI_MODEL_CHOICES.map((choice) => ({
      id: choice.id,
      provider: choice.provider,
      label: choice.label,
      inRupees: Math.round(choice.inUsd * AI_USD_TO_INR),
      outRupees: Math.round(choice.outUsd * AI_USD_TO_INR),
    })),
    usage: {
      month: indiaMonth(now),
      totalCostPaise: usage?.totalCostPaise ?? 0,
      runs: usage?.runs ?? 0,
      byTask: Object.entries(usage?.byTask ?? {})
        .map(([task, value]) => ({ task, costPaise: value.costPaise ?? 0, runs: value.runs ?? 0 }))
        .sort((a, b) => b.costPaise - a.costPaise),
    },
  };
}

/**
 * @param {{ monthlyCapPaise?: number, dailyRunsPerUser?: number, alertPercent?: number,
 *           models?: Record<string, { model: string, fallback: string | null }> }} changes
 *        Already validated: model ids are from the list of choices
 */
export async function updateAiSettings(actor, changes, context = {}) {
  const { models = {}, ...limits } = changes;
  for (const [key, choice] of Object.entries(models)) {
    if (choice.fallback && choice.fallback === choice.model) {
      throw badRequest('Choose a different model as the second choice', [
        { field: `models.${key}.fallback` },
      ]);
    }
  }
  const set = {
    ...Object.fromEntries(Object.entries(limits).map(([field, value]) => [`ai.${field}`, value])),
    ...Object.fromEntries(
      Object.entries(models).map(([key, value]) => [`ai.models.${key}`, value]),
    ),
  };
  const settings = await Settings.findOneAndUpdate({ key: 'app' }, { $set: set }).lean();
  if (!settings) throw badRequest('The settings are not set up yet. Run the seed first.');
  // A new budget or warning level: this month's marks start again, so the warnings can come
  // again at the new numbers.
  if ('monthlyCapPaise' in limits || 'alertPercent' in limits) {
    await AiUsageMonthly.updateOne(
      { month: indiaMonth(new Date()) },
      { $unset: { alert80SentAt: '', capReachedAt: '' } },
    );
  }
  await writeAudit({
    actor,
    action: 'settings.ai_updated',
    entityType: 'settings',
    entityId: settings._id,
    oldValue: settings.ai ?? null,
    newValue: changes,
    requestId: context.requestId,
  });
  return getAiSettingsView();
}
