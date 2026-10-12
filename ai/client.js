import { env } from '../config/env.js';
import { createAppError } from '../lib/errors.js';
import { AI_API_URL, AI_DEFAULT_MAX_TOKENS, AI_MODELS, AI_TIMEOUT_MS } from './config.js';

// The only file that talks to a language model (through OpenRouter). Nothing outside
// server/ai/ may import it: every model call goes through runAiTask() in runTask.js, which
// adds the spending cap, the redaction, the validation and the record in `ai_runs`.

export function isAiConfigured() {
  return Boolean(env.OPENROUTER_API_KEY);
}

/**
 * One model call that must answer with JSON.
 * @param {{ modelClass: 'fast' | 'balanced' | 'strong', system: string, user: string,
 *           maxTokens?: number }} request
 * @returns {Promise<{ text: string, model: string, promptTokens: number,
 *                     completionTokens: number, costUsd: number, latencyMs: number }>}
 */
export async function callModel({ modelClass, system, user, maxTokens = AI_DEFAULT_MAX_TOKENS }) {
  if (!isAiConfigured()) throw createAppError('AI_NOT_CONFIGURED', 503, 'AI is not set up yet.');
  const choice = AI_MODELS[modelClass];
  if (!choice) throw new Error(`Unknown AI model class: ${modelClass}`);

  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(AI_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // The first model that is available answers; the others are fallbacks.
        models: [choice.model, ...choice.fallbacks],
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: maxTokens,
        // Never a provider that keeps or trains on what we send.
        provider: { data_collection: 'deny' },
        // Ask for the real cost of this call in the answer.
        usage: { include: true },
      }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? 'it took too long' : 'it could not be reached';
    throw createAppError('AI_PROVIDER_ERROR', 502, `The AI service did not answer: ${reason}.`);
  }

  const body = await response.json().catch(() => null);
  const text = body?.choices?.[0]?.message?.content;
  if (!response.ok || typeof text !== 'string') {
    // The provider's own words say what is wrong (no credit, model gone, key refused).
    const reason = String(body?.error?.message ?? `status ${response.status}`).slice(0, 200);
    throw createAppError('AI_PROVIDER_ERROR', 502, `The AI service refused the request: ${reason}`);
  }
  return {
    text,
    model: String(body.model ?? choice.model),
    promptTokens: Number(body.usage?.prompt_tokens ?? 0),
    completionTokens: Number(body.usage?.completion_tokens ?? 0),
    costUsd: Number(body.usage?.cost ?? 0),
    latencyMs: Date.now() - startedAt,
  };
}
