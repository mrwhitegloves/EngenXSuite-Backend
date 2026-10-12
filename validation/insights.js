import { z } from 'zod';
import { AI_MODEL_CHOICES, AI_MODEL_CLASS_KEYS } from '../ai/config.js';

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
    // Per class of work: the model, and the one tried when it is not available.
    models: z
      .object(Object.fromEntries(AI_MODEL_CLASS_KEYS.map((key) => [key, classChoice])))
      .partial(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });
