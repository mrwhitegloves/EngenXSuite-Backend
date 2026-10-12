import { z } from 'zod';
import { runAiTask } from '../runTask.js';

// AI task: how good one lead looks (a score with reasons) and the next best action, in one
// model call. The answer is advice to read. It can never carry a price, a discount, an owner
// or a stage: those fields do not exist in the schema below.

export const ASSESS_LEAD_VERSION = 'assessLead/v1';

const line = z.string().trim().min(1).max(300);
export const leadAssessmentSchema = z.object({
  // 0 to 100: how likely this lead is to be won, from what the records say.
  score: z.number().int().min(0).max(100),
  // Why the score is what it is: what speaks for the lead, and what against it.
  positives: z.array(line).max(4),
  concerns: z.array(line).max(4),
  // How likely it is to be lost or to stall.
  riskLevel: z.enum(['low', 'medium', 'high']),
  // The one thing to do next, and why.
  nextBestAction: z.object({ action: line, reason: line }),
  // What the records do not say and a sales person should find out.
  missingInformation: z.array(line).max(5),
});

const SYSTEM = `You are a sales coach for a company that sells industrial AI, digital transformation and engineering solutions to factories in India.
You get the CRM records of ONE lead (a possible sale) as JSON: the lead, its company, its people, its stage, its tasks and its history.
Judge how likely it is to be won, and say what the sales person should do next.

Rules:
- Use only what is in the records. Never invent a fact, a number, a name or a date.
- A lead with little information cannot score high: say what is missing in "missingInformation".
- Things that speak for a lead: a clear requirement, a known decision maker, an approved or planned budget, recent two-way contact, a next step with a date.
- Things that speak against it: no contact for a long time, many days in the same stage, no budget, a strong competitor, overdue tasks, no decision maker.
- "nextBestAction" is ONE concrete step the sales person can do this week, with whom when the records say so.
- Never suggest a price, a discount, a change of owner or a change of stage.
- Always write in plain, simple, correct English, also when the records are in Hindi or Hinglish. Short sentences.
- "today" in the records is today's date.

Answer with one JSON object and nothing else:
{
  "score": 0-100,
  "positives": ["up to 4 short reasons for"],
  "concerns": ["up to 4 short reasons against"],
  "riskLevel": "low" | "medium" | "high",
  "nextBestAction": { "action": "one step", "reason": "why this step now" },
  "missingInformation": ["up to 5 things to find out"]
}`;

/**
 * @param {{ context: object, leadId: unknown, userId?: unknown,
 *           inputRefs?: { kind: string, id: unknown }[] }} input
 * @returns {Promise<{ output: z.infer<typeof leadAssessmentSchema>, runId: string, model: string }>}
 */
export function assessLead({ context, leadId, userId, inputRefs }) {
  return runAiTask({
    task: 'assessLead',
    promptVersion: ASSESS_LEAD_VERSION,
    modelClass: 'balanced',
    system: SYSTEM,
    user: JSON.stringify(context),
    schema: leadAssessmentSchema,
    inputRefs,
    userId,
    entityType: 'opportunities',
    entityId: leadId,
    maxTokens: 3000,
  });
}
