import { z } from 'zod';
import {
  AI_CHAT,
  AI_MODEL_CHOICES,
  AI_MODEL_CLASS_KEYS,
  AI_TRANSCRIBE_CHOICES,
} from '../ai/config.js';
import { objectId } from './common.js';
import { FEEDBACK_VERDICTS } from '../models/aiFeedback.model.js';

const modelId = z.enum(AI_MODEL_CHOICES.map((choice) => choice.id));
const classChoice = z.object({ model: modelId, fallback: modelId.nullable() });

export const updateAiSettingsBody = z
  .object({
    // ₹100 to ₹1,00,000 a month, in paise.
    monthlyCapPaise: z
      .number()
      .int()
      .min(100 * 100)
      .max(100000 * 100),
    dailyRunsPerUser: z.number().int().min(1).max(1000),
    // Warn when this much of the budget is used.
    alertPercent: z.number().int().min(10).max(99),
    autoRefresh: z.boolean(),
    transcribeModel: z.enum(AI_TRANSCRIBE_CHOICES.map((choice) => choice.id)),
    // Per class of work: the model, and the one tried when it is not available.
    models: z
      .object(Object.fromEntries(AI_MODEL_CLASS_KEYS.map((key) => [key, classChoice])))
      .partial(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });

export const feedbackBody = z
  .object({
    verdict: z.enum(FEEDBACK_VERDICTS),
    // "edited": what it should have said. "rejected": what was wrong (optional).
    note: z.string().trim().max(2000).optional(),
  })
  .refine((body) => body.verdict !== 'edited' || Boolean(body.note), {
    message: 'Write what it should have said',
    path: ['note'],
  });

const chatMessage = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(AI_CHAT.maxMessageCharacters),
  // Files the person added, already turned into text (see POST /api/ai/chat/files).
  attachments: z
    .array(
      z.object({
        name: z.string().max(200),
        text: z.string().max(AI_CHAT.maxAttachmentCharacters + 200),
      }),
    )
    .max(5)
    .optional(),
});

export const chatBody = z
  .object({
    messages: z.array(chatMessage).min(1).max(AI_CHAT.maxMessages),
    // How the person wants the answers ("in 5 points", "only the risks").
    instruction: z.string().trim().max(AI_CHAT.maxInstructionCharacters).optional(),
    // The CRM records this conversation is about.
    context: z
      .array(z.object({ type: z.enum(['lead', 'account', 'contact', 'call']), id: objectId }))
      .max(AI_CHAT.maxContextRecords)
      .optional(),
  })
  .refine((body) => body.messages.at(-1)?.role === 'user', {
    message: 'The last message must be yours',
    path: ['messages'],
  })
  .refine(
    (body) => body.messages.at(-1)?.content.trim() || body.messages.at(-1)?.attachments?.length,
    {
      message: 'Write a question',
      path: ['messages'],
    },
  );
