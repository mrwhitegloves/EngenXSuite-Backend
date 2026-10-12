// The starting values of the AI layer, and the list of models that can be chosen. The values
// in force are settings (Settings → AI, read through ai/settings.js): the CEO changes the
// budget, the limits and which model does which class of work without a change of code.
//
// Model ids and prices were read from https://openrouter.ai/api/v1/models on 2026-10-12
// (US dollars per 1 million tokens, in / out). Check them again when the list is changed.

/**
 * The models that can be chosen in Settings → AI. A model not in this list cannot be used: a
 * new one is added here after its price was checked.
 */
export const AI_MODEL_CHOICES = [
  {
    id: 'anthropic/claude-haiku-5.5',
    provider: 'Anthropic',
    label: 'Claude Haiku 5.5',
    inUsd: 0.1,
    outUsd: 0.5,
  },
  {
    id: 'anthropic/claude-sonnet-5.5',
    provider: 'Anthropic',
    label: 'Claude Sonnet 5.5',
    inUsd: 2,
    outUsd: 10,
  },
  {
    id: 'anthropic/claude-opus-5.5',
    provider: 'Anthropic',
    label: 'Claude Opus 5.5',
    inUsd: 4,
    outUsd: 20,
  },
  {
    id: 'google/gemini-3.1-flash-lite',
    provider: 'Google',
    label: 'Gemini 3.1 Flash-Lite',
    inUsd: 0.25,
    outUsd: 1.5,
  },
  {
    id: 'google/gemini-3.8-flash',
    provider: 'Google',
    label: 'Gemini 3.8 Flash',
    inUsd: 0.75,
    outUsd: 3.75,
  },
  {
    id: 'google/gemini-3.1-pro-preview',
    provider: 'Google',
    label: 'Gemini 3.1 Pro',
    inUsd: 2,
    outUsd: 12,
  },
  {
    id: 'openai/gpt-5.4-nano',
    provider: 'OpenAI',
    label: 'GPT-5.4 nano',
    inUsd: 0.2,
    outUsd: 1.25,
  },
  {
    id: 'openai/gpt-5.4-mini',
    provider: 'OpenAI',
    label: 'GPT-5.4 mini',
    inUsd: 0.75,
    outUsd: 4.5,
  },
  { id: 'openai/gpt-5.4', provider: 'OpenAI', label: 'GPT-5.4', inUsd: 2.5, outUsd: 15 },
  { id: 'openai/gpt-5.5', provider: 'OpenAI', label: 'GPT-5.5', inUsd: 5, outUsd: 30 },
];

/**
 * A class of work → the model that does it, and the one tried next when it is not available.
 * The starting choice; Settings → AI can change each of them.
 */
export const AI_MODEL_CLASSES = {
  fast: {
    label: 'Fast and cheap',
    usedFor: 'Scoring, sorting, column mapping: many small runs',
    model: 'anthropic/claude-haiku-5.5',
    fallback: 'google/gemini-3.1-flash-lite',
  },
  balanced: {
    label: 'Balanced',
    usedFor: 'Summaries of companies and calls, next best action',
    model: 'anthropic/claude-haiku-5.5',
    fallback: 'google/gemini-3.8-flash',
  },
  strong: {
    label: 'Strong',
    usedFor: 'Proposals, CEO insights: few, long runs',
    model: 'anthropic/claude-sonnet-5.5',
    fallback: 'openai/gpt-5.4',
  },
};
export const AI_MODEL_CLASS_KEYS = Object.keys(AI_MODEL_CLASSES);

export const AI_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
// One model call may take this long before it counts as failed.
export const AI_TIMEOUT_MS = 60_000;
// The longest answer a task may ask for, unless it says otherwise. Generous on purpose: an
// answer that is cut off is not valid JSON and is paid for twice (found with a real model:
// 900 was too little for a company summary).
export const AI_DEFAULT_MAX_TOKENS = 3000;

// The provider bills in US dollars; the cap is kept in rupees. An assumption, not a live rate:
// set a little high on purpose, so the counted spend is never below the real one.
export const AI_USD_TO_INR = 90;

// Each morning the system asks the AI again about open leads (and companies) whose answer is
// older than this: time alone changes the picture ("no contact for 9 days"). Only answers
// somebody asked for before, only while "keep answers up to date" is on, and no more than this
// many a day.
export const AI_DAILY_REFRESH = {
  leadAfterDays: 3,
  accountAfterDays: 7,
  maxLeads: 50,
  maxAccounts: 20,
};

// The starting limits; all three are edited in Settings → AI.
export const AI_DEFAULT_MONTHLY_CAP_PAISE = 2000 * 100;
export const AI_DEFAULT_DAILY_RUNS_PER_USER = 100;
// The people who manage the settings are told once when this much of the cap is used.
export const AI_DEFAULT_ALERT_PERCENT = 80;
