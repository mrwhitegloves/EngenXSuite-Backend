import { logger } from '../infra/logger.js';
import { createAppError } from '../lib/errors.js';
import { AiRun } from '../models/aiRun.model.js';
import { checkBudget, recordUsage, usdToPaise } from './budget.js';
import { callChatModel, isAiConfigured, transcribeAudio } from './client.js';
import { AI_AUDIO_MAX_BYTES, AI_AUDIO_PIECE_BYTES, AI_MODEL_CLASS_KEYS } from './config.js';
import { redact } from './redact.js';
import { getAiSettings } from './settings.js';

// The other ways to use a model, next to runAiTask(): a conversation (free text in, free text
// out) and audio to text. Both pass the same gates: the spending cap, the person's daily
// number, redaction of what is sent, and a line in `ai_runs`.
//
// Founder decision (2026-10-12): what people say to the AI chat and what it answers is NOT
// kept. For these runs `ai_runs` holds only who, when, which model and the cost: no text.

async function gate(userId, base) {
  if (!isAiConfigured()) throw createAppError('AI_NOT_CONFIGURED', 503, 'AI is not set up yet.');
  const budget = await checkBudget({ userId });
  if (!budget.allowed) {
    await AiRun.create({ ...base, status: budget.status, error: budget.message });
    throw createAppError('AI_LIMIT_REACHED', 429, budget.message);
  }
}

const countUsage = (task, costPaise, userId) =>
  recordUsage({ task, costPaise, userId }).catch((error) =>
    logger.error({ err: error, task }, 'AI usage could not be counted'),
  );

/** Text parts are redacted; images and files are passed on as they are. */
const redactContent = (content) =>
  typeof content === 'string'
    ? redact(content)
    : content.map((part) => (part.type === 'text' ? { ...part, text: redact(part.text) } : part));

/**
 * One turn of a conversation: the instructions, the messages so far, one answer in free text.
 * @param {{ task: string, modelClass?: 'fast' | 'balanced' | 'strong', system: string,
 *           messages: { role: 'user' | 'assistant', content: string | object[] }[],
 *           userId?: unknown, inputRefs?: { kind: string, id: unknown }[], maxTokens?: number }} request
 * @returns {Promise<{ text: string, model: string }>}
 */
export async function runAiChat({
  task,
  modelClass = 'balanced',
  system,
  messages,
  userId,
  inputRefs = [],
  maxTokens,
}) {
  if (!AI_MODEL_CLASS_KEYS.includes(modelClass)) {
    throw new Error(`Unknown AI model class: ${modelClass}`);
  }
  const base = { task, promptVersion: `${task}/v1`, inputRefs, userId };
  await gate(userId, base);
  const choice = (await getAiSettings()).models[modelClass];

  let answer;
  try {
    answer = await callChatModel({
      models: [choice.model, choice.fallback].filter(Boolean),
      messages: [
        { role: 'system', content: redact(system) },
        ...messages.map((message) => ({
          role: message.role,
          content: redactContent(message.content),
        })),
      ],
      maxTokens,
    });
  } catch (error) {
    await AiRun.create({ ...base, status: 'failed', error: String(error?.message).slice(0, 500) });
    throw error;
  }
  const costPaise = usdToPaise(answer.costUsd);
  // No `output`: the conversation is not kept.
  await AiRun.create({
    ...base,
    model: answer.model,
    status: 'success',
    promptTokens: answer.promptTokens,
    completionTokens: answer.completionTokens,
    costMicroUsd: Math.round(answer.costUsd * 1e6),
    costPaise,
    latencyMs: answer.latencyMs,
  });
  await countUsage(task, costPaise, userId);
  return { text: answer.text, model: answer.model };
}

/**
 * Cut an MP3 into pieces at frame starts, so each piece can be played (and heard) on its own.
 * Other formats cannot be cut this simply: they must fit into one piece.
 * @returns {Buffer[]}
 */
export function splitAudio(audio, format, pieceBytes = AI_AUDIO_PIECE_BYTES) {
  if (audio.length <= pieceBytes) return [audio];
  if (format !== 'mp3') {
    throw createAppError(
      'AUDIO_TOO_LARGE',
      400,
      `This recording is too large for its format. Use an MP3, or a file under ${Math.round(pieceBytes / 1024 / 1024)} MB.`,
    );
  }
  const pieces = [];
  let start = 0;
  while (start < audio.length) {
    let end = Math.min(start + pieceBytes, audio.length);
    // Move on to the next MP3 frame start (11 set bits): 0xFF, then 0xE0 or above.
    while (end < audio.length - 1 && !(audio[end] === 0xff && (audio[end + 1] & 0xe0) === 0xe0)) {
      end += 1;
    }
    if (end >= audio.length - 1) end = audio.length;
    pieces.push(audio.subarray(start, end));
    start = end;
  }
  return pieces;
}

/**
 * Audio to text. A long recording is sent in pieces and the texts are joined.
 * @param {{ audio: Buffer, format: string, userId?: unknown, entityType?: string,
 *           entityId?: unknown }} request
 * @returns {Promise<{ text: string, model: string, seconds: number, runId: string }>}
 */
export async function runAiTranscription({ audio, format, userId, entityType, entityId }) {
  const task = 'transcribeAudio';
  const base = { task, promptVersion: `${task}/v1`, userId, entityType, entityId };
  await gate(userId, base);
  const { transcribeModel: model } = await getAiSettings();
  const pieces = splitAudio(audio, format);
  if (pieces.some((piece) => piece.length > AI_AUDIO_MAX_BYTES)) {
    throw createAppError('AUDIO_TOO_LARGE', 400, 'This recording is too large to be read.');
  }

  const texts = [];
  let seconds = 0;
  let runId;
  for (const piece of pieces) {
    let answer;
    try {
      answer = await transcribeAudio({ model, audio: piece, format });
    } catch (error) {
      await AiRun.create({
        ...base,
        model,
        status: 'failed',
        error: String(error?.message).slice(0, 500),
      });
      throw error;
    }
    const costPaise = usdToPaise(answer.costUsd);
    // No `output`: the text is the caller's to keep (a call's transcript) or not (a chat).
    const run = await AiRun.create({
      ...base,
      model,
      status: 'success',
      costMicroUsd: Math.round(answer.costUsd * 1e6),
      costPaise,
      latencyMs: answer.latencyMs,
    });
    await countUsage(task, costPaise, userId);
    runId = String(run._id);
    seconds += answer.seconds;
    texts.push(answer.text.trim());
  }
  return { text: texts.filter(Boolean).join('\n'), model, seconds, runId };
}
