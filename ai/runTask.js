import { logger } from '../infra/logger.js';
import { createAppError } from '../lib/errors.js';
import { AiRun } from '../models/aiRun.model.js';
import { checkBudget, recordUsage, usdToPaise } from './budget.js';
import { callModel, isAiConfigured } from './client.js';
import { AI_MODEL_CLASS_KEYS } from './config.js';
import { redact } from './redact.js';
import { getAiSettings } from './settings.js';

// THE way to use a language model. Every AI feature is a "task": a small function that builds a
// prompt from CRM records and calls runAiTask() with the shape (a Zod schema) the answer must have.
//
// What runAiTask() does, in order:
//   1. checks the spending cap and the person's daily limit (refuses with a clear message);
//   2. takes tax ids, bank details and secrets out of the prompt (redact);
//   3. makes ONE model call; when the answer does not fit the schema, ONE more with the reason;
//   4. writes every call to `ai_runs`, and counts its cost;
//   5. gives back the validated answer, or fails as a whole. Never a half-filled answer.
//
// It never changes a CRM record. A task's answer is a proposal that a person accepts through the
// normal services. No loops, no tools, no agents: one question, one answer.

const cannotProcess = () =>
  createAppError('AI_INVALID_OUTPUT', 502, 'The AI could not process this. Try again.');

/** The JSON in a model's answer; undefined when it is not JSON. A code fence is allowed. */
function parseJson(text) {
  const body = String(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** What is wrong with an answer, in words the model (and a developer) can use. */
function problemsOf(parsed, result) {
  if (parsed === undefined) return 'The answer was not valid JSON.';
  return result.error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/**
 * Run one AI task.
 *
 * @param {{
 *   task: string,                 the task's name, for example 'summarizeAccount'
 *   promptVersion: string,        for example 'summarizeAccount/v1'
 *   modelClass?: 'fast' | 'balanced' | 'strong',
 *   system: string,               the instructions
 *   user: string,                 the data to work on
 *   schema: import('zod').ZodType,  the shape the answer must have
 *   inputRefs?: { kind: string, id: unknown }[],  the records the prompt was built from
 *   userId?: unknown,             who asked; empty for runs the system starts by itself
 *   entityType?: string, entityId?: unknown,      the record the run is about
 *   maxTokens?: number,
 * }} request
 * @returns {Promise<{ output: any, runId: string, model: string }>}
 */
export async function runAiTask({
  task,
  promptVersion,
  modelClass = 'balanced',
  system,
  user,
  schema,
  inputRefs = [],
  userId,
  entityType,
  entityId,
  maxTokens,
}) {
  if (!isAiConfigured()) throw createAppError('AI_NOT_CONFIGURED', 503, 'AI is not set up yet.');
  const base = { task, promptVersion, inputRefs, userId, entityType, entityId };

  const budget = await checkBudget({ userId });
  if (!budget.allowed) {
    await AiRun.create({ ...base, status: budget.status, error: budget.message });
    throw createAppError('AI_LIMIT_REACHED', 429, budget.message);
  }

  if (!AI_MODEL_CLASS_KEYS.includes(modelClass)) {
    throw new Error(`Unknown AI model class: ${modelClass}`);
  }
  // Which model does this class of work is a setting (Settings → AI).
  const choice = (await getAiSettings()).models[modelClass];
  const models = [choice.model, choice.fallback].filter(Boolean);

  const prompt = { system: redact(system), user: redact(user) };
  let retryOf;
  let hint = '';
  // The first try, and one more when the answer does not fit.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let answer;
    try {
      answer = await callModel({
        models,
        system: prompt.system,
        user: prompt.user + hint,
        maxTokens,
      });
    } catch (error) {
      await AiRun.create({
        ...base,
        status: 'failed',
        error: String(error?.message ?? error).slice(0, 500),
        retryOf,
      });
      throw error;
    }

    const costPaise = usdToPaise(answer.costUsd);
    const parsed = parseJson(answer.text);
    const result = parsed === undefined ? null : schema.safeParse(parsed);
    const isValid = Boolean(result?.success);
    const problems = isValid ? undefined : problemsOf(parsed, result);
    const run = await AiRun.create({
      ...base,
      model: answer.model,
      status: isValid ? 'success' : 'invalid_output',
      // The validated answer; or what came back, for someone who looks into the failure.
      output: isValid ? result.data : answer.text.slice(0, 5000),
      error: problems?.slice(0, 500),
      promptTokens: answer.promptTokens,
      completionTokens: answer.completionTokens,
      costMicroUsd: Math.round(answer.costUsd * 1e6),
      costPaise,
      latencyMs: answer.latencyMs,
      retryOf,
    });
    // A call that came back costs money, valid or not.
    await recordUsage({ task, costPaise, userId }).catch((error) =>
      logger.error({ err: error, task }, 'AI usage could not be counted'),
    );
    if (isValid) return { output: result.data, runId: String(run._id), model: answer.model };

    retryOf = run._id;
    hint = `\n\nYour last answer could not be used: ${problems}\nAnswer again with only the JSON object, exactly in the shape asked for.`;
  }
  throw cannotProcess();
}
