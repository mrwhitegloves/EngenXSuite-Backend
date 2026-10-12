import { z } from 'zod';
import { runAiTask } from '../runTask.js';

// AI task: the summary of one customer company, from its CRM records.
// The caller (services/insights.service.js) has checked access and hands over only what the
// person may see. The answer is text to read: it changes nothing in the CRM.

export const SUMMARIZE_ACCOUNT_VERSION = 'summarizeAccount/v1';

const line = z.string().trim().min(1).max(300);
export const accountSummarySchema = z.object({
  // Two to four sentences: who they are and where we stand with them.
  summary: z.string().trim().min(1).max(900),
  // What matters most right now, most important first.
  keyPoints: z.array(line).max(5),
  // Chances to sell or grow, and things that could go wrong. Empty when the records show none.
  opportunities: z.array(line).max(4),
  risks: z.array(line).max(4),
  // What a sales person should find out next, because the records do not say.
  missingInformation: z.array(line).max(5),
});

const SYSTEM = `You are a sales analyst for a company that sells industrial AI, digital transformation and engineering solutions to factories in India.
You get the CRM records of ONE customer company as JSON. Write a short briefing for the sales person who looks after it.

Rules:
- Use only what is in the records. Never invent a fact, a number, a name or a date.
- When something important is not in the records, put it in "missingInformation" instead of guessing.
- Plain, simple English. Short sentences. No sales talk, no filler.
- Money in the records is in Indian rupees.
- Do not suggest a price, a discount, a new owner or a stage change.

Answer with one JSON object and nothing else:
{
  "summary": "2 to 4 sentences: who they are, and where we stand with them",
  "keyPoints": ["up to 5 short points, most important first"],
  "opportunities": ["up to 4 chances to sell or grow; [] when the records show none"],
  "risks": ["up to 4 things that could go wrong; [] when the records show none"],
  "missingInformation": ["up to 5 things to find out next"]
}`;

/**
 * @param {{ context: object, accountId: unknown, userId?: unknown,
 *           inputRefs?: { kind: string, id: unknown }[] }} input
 *        context: the company's records as plain data (built by the insights service)
 * @returns {Promise<{ output: z.infer<typeof accountSummarySchema>, runId: string, model: string }>}
 */
export function summarizeAccount({ context, accountId, userId, inputRefs }) {
  return runAiTask({
    task: 'summarizeAccount',
    promptVersion: SUMMARIZE_ACCOUNT_VERSION,
    modelClass: 'balanced',
    system: SYSTEM,
    user: JSON.stringify(context),
    schema: accountSummarySchema,
    inputRefs,
    userId,
    entityType: 'accounts',
    entityId: accountId,
    maxTokens: 3000,
  });
}
