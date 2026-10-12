import { env } from '../config/env.js';
import { createAppError } from '../lib/errors.js';
import {
  AI_API_URL,
  AI_DEFAULT_MAX_TOKENS,
  AI_TIMEOUT_MS,
  AI_TRANSCRIBE_TIMEOUT_MS,
  AI_TRANSCRIBE_URL,
} from './config.js';

// The only file that talks to a language model (through OpenRouter). Nothing outside
// server/ai/ may import it: every model call goes through runAiTask() in runTask.js, which
// adds the spending cap, the redaction, the validation and the record in `ai_runs`.

export function isAiConfigured() {
  return Boolean(env.OPENROUTER_API_KEY);
}

/**
 * One model call that must answer with JSON.
 * @param {{ models: string[], system: string, user: string, maxTokens?: number }} request
 *        models: the model to use first, then the ones tried when it is not available
 * @returns {Promise<{ text: string, model: string, promptTokens: number,
 *                     completionTokens: number, costUsd: number, latencyMs: number }>}
 */
export async function callModel({ models, system, user, maxTokens = AI_DEFAULT_MAX_TOKENS }) {
  if (!isAiConfigured()) throw createAppError('AI_NOT_CONFIGURED', 503, 'AI is not set up yet.');
  if (!models?.length) throw new Error('callModel needs at least one model');

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
        models,
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
    model: String(body.model ?? models[0]),
    promptTokens: Number(body.usage?.prompt_tokens ?? 0),
    completionTokens: Number(body.usage?.completion_tokens ?? 0),
    costUsd: Number(body.usage?.cost ?? 0),
    latencyMs: Date.now() - startedAt,
  };
}

async function post(url, body, timeoutMs) {
  if (!isAiConfigured()) throw createAppError('AI_NOT_CONFIGURED', 503, 'AI is not set up yet.');
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? 'it took too long' : 'it could not be reached';
    throw createAppError('AI_PROVIDER_ERROR', 502, `The AI service did not answer: ${reason}.`);
  }
  const answer = await response.json().catch(() => null);
  if (!response.ok || !answer) {
    const reason = String(answer?.error?.message ?? `status ${response.status}`).slice(0, 200);
    throw createAppError('AI_PROVIDER_ERROR', 502, `The AI service refused the request: ${reason}`);
  }
  return answer;
}

/**
 * One model call that answers in free text (the AI chat, reading a file).
 * @param {{ models: string[], messages: { role: string, content: string | object[] }[],
 *           maxTokens?: number }} request
 *        content: text, or parts (text, an image, a file) in the provider's format
 * @returns {Promise<{ text: string, model: string, promptTokens: number,
 *                     completionTokens: number, costUsd: number, latencyMs: number }>}
 */
export async function callChatModel({ models, messages, maxTokens = AI_DEFAULT_MAX_TOKENS }) {
  if (!models?.length) throw new Error('callChatModel needs at least one model');
  const startedAt = Date.now();
  const answer = await post(
    AI_API_URL,
    {
      models,
      messages,
      temperature: 0.3,
      max_tokens: maxTokens,
      provider: { data_collection: 'deny' },
      usage: { include: true },
    },
    AI_TIMEOUT_MS,
  );
  const text = answer.choices?.[0]?.message?.content;
  if (typeof text !== 'string') {
    throw createAppError('AI_PROVIDER_ERROR', 502, 'The AI service sent no answer.');
  }
  return {
    text,
    model: String(answer.model ?? models[0]),
    promptTokens: Number(answer.usage?.prompt_tokens ?? 0),
    completionTokens: Number(answer.usage?.completion_tokens ?? 0),
    costUsd: Number(answer.usage?.cost ?? 0),
    latencyMs: Date.now() - startedAt,
  };
}

/**
 * Audio to text, for one piece of audio (at most 25 MB).
 * @param {{ model: string, audio: Buffer, format: string }} request  format: mp3, wav, m4a, …
 * @returns {Promise<{ text: string, seconds: number, costUsd: number, latencyMs: number }>}
 */
export async function transcribeAudio({ model, audio, format }) {
  const startedAt = Date.now();
  const answer = await post(
    AI_TRANSCRIBE_URL,
    { model, input_audio: { data: audio.toString('base64'), format } },
    AI_TRANSCRIBE_TIMEOUT_MS,
  );
  if (typeof answer.text !== 'string') {
    throw createAppError('AI_PROVIDER_ERROR', 502, 'The AI service sent no text for the audio.');
  }
  return {
    text: answer.text,
    seconds: Number(answer.usage?.seconds ?? 0),
    costUsd: Number(answer.usage?.cost ?? 0),
    latencyMs: Date.now() - startedAt,
  };
}
