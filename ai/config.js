// Every setting of the AI layer in one place: which model does which class of work, and the
// limits. Changing a model is a one-line change here; nothing else names a model.
//
// Model ids and prices were read from https://openrouter.ai/api/v1/models on 2026-10-12
// (US dollars per 1 million tokens, in / out). Check them again when a model is changed.

/**
 * A class of work → the model that does it, and the models tried next when it is not available.
 *   fast     : sorting, scoring, column mapping (many small runs)
 *   balanced : summaries, next best action
 *   strong   : proposals, CEO insights (few, long runs)
 */
export const AI_MODELS = {
  // claude-haiku-5.5: 0.10 / 0.50. gemini-3.1-flash-lite: 0.25 / 1.50.
  fast: { model: 'anthropic/claude-haiku-5.5', fallbacks: ['google/gemini-3.1-flash-lite'] },
  // gemini-3.8-flash: 0.75 / 3.75.
  balanced: { model: 'anthropic/claude-haiku-5.5', fallbacks: ['google/gemini-3.8-flash'] },
  // claude-sonnet-5.5 and claude-sonnet-5: 2 / 10.
  strong: { model: 'anthropic/claude-sonnet-5.5', fallbacks: ['anthropic/claude-sonnet-5'] },
};
export const AI_MODEL_CLASSES = Object.keys(AI_MODELS);

export const AI_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
// One model call may take this long before it counts as failed.
export const AI_TIMEOUT_MS = 60_000;
// The longest answer a task may ask for, unless it says otherwise.
export const AI_DEFAULT_MAX_TOKENS = 1500;

// The provider bills in US dollars; the cap is kept in rupees. An assumption, not a live rate:
// set a little high on purpose, so the counted spend is never below the real one.
export const AI_USD_TO_INR = 90;

// The starting limits. Both are settings (`settings.ai`), edited by the CEO.
export const AI_DEFAULT_MONTHLY_CAP_PAISE = 2000 * 100;
export const AI_DEFAULT_DAILY_RUNS_PER_USER = 100;
// The people who manage the settings are told once when this share of the cap is used.
export const AI_ALERT_SHARE = 0.8;
