import { Settings } from '../models/settings.model.js';
import { isAiConfigured } from './client.js';
import {
  AI_DEFAULT_ALERT_PERCENT,
  AI_DEFAULT_DAILY_RUNS_PER_USER,
  AI_DEFAULT_MONTHLY_CAP_PAISE,
  AI_DEFAULT_TRANSCRIBE_MODEL,
  AI_TRANSCRIBE_CHOICES,
  AI_MODEL_CHOICES,
  AI_MODEL_CLASSES,
  AI_MODEL_CLASS_KEYS,
} from './config.js';

// The AI settings in force: what was saved in Settings → AI, and the starting values for
// everything that was never saved. Read before every model call.

/** True when the AI key is set. For code outside server/ai, which never imports the client. */
export const isAiReady = () => isAiConfigured();

const isChoice = (id) => AI_MODEL_CHOICES.some((choice) => choice.id === id);

/**
 * @returns {Promise<{ monthlyCapPaise: number, dailyRunsPerUser: number, alertPercent: number,
 *                     autoRefresh: boolean,
 *                     models: Record<string, { model: string, fallback: string | null }> }>}
 */
export async function getAiSettings() {
  const saved = (await Settings.findOne({ key: 'app' }).select('ai').lean())?.ai ?? {};
  const models = Object.fromEntries(
    AI_MODEL_CLASS_KEYS.map((key) => {
      const start = AI_MODEL_CLASSES[key];
      const chosen = saved.models?.[key] ?? {};
      // A saved model that was later taken off the list falls back to the starting choice.
      const model = isChoice(chosen.model) ? chosen.model : start.model;
      const fallback =
        chosen.fallback === null
          ? null
          : isChoice(chosen.fallback)
            ? chosen.fallback
            : start.fallback;
      return [key, { model, fallback: fallback === model ? null : fallback }];
    }),
  );
  return {
    monthlyCapPaise: saved.monthlyCapPaise ?? AI_DEFAULT_MONTHLY_CAP_PAISE,
    dailyRunsPerUser: saved.dailyRunsPerUser ?? AI_DEFAULT_DAILY_RUNS_PER_USER,
    alertPercent: saved.alertPercent ?? AI_DEFAULT_ALERT_PERCENT,
    // Ask the AI again by itself when something happens on a record that has an insight.
    autoRefresh: saved.autoRefresh ?? true,
    // The audio-to-text model, from the list in config.js.
    transcribeModel: AI_TRANSCRIBE_CHOICES.some((choice) => choice.id === saved.transcribeModel)
      ? saved.transcribeModel
      : AI_DEFAULT_TRANSCRIBE_MODEL,
    models,
  };
}
