import { z } from 'zod';
import { runAiTask } from '../runTask.js';

// The summary of a meeting, from the notes a person wrote (or a voice note turned into text).
// It proposes tasks; none is created until a person accepts it.

export const SUMMARIZE_MEETING_VERSION = 'summarizeMeeting/v1';

const lines = z.array(z.string().trim().min(1).max(400)).max(10);

export const meetingSummarySchema = z.object({
  summary: z.string().trim().min(1).max(3000),
  clientProblems: lines,
  machinesDiscussed: lines,
  technicalRequirements: lines,
  budget: z.string().trim().max(500),
  decisionMakers: lines,
  competitors: lines,
  commitments: lines,
  nextSteps: lines,
  risks: lines,
  missingInformation: lines,
  proposedTasks: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        // In how many days from the meeting it should be done; null when the notes do not say.
        dueInDays: z.number().int().min(0).max(365).nullable(),
      }),
    )
    .max(8),
});

const SYSTEM = `You help a sales person of a company that sells industrial AI, digital transformation and engineering solutions to factories in India.
You get JSON with one meeting with a customer: what the CRM knows about it ("meeting") and what the sales person wrote down or said afterwards ("notes"; it may be rough, short, or in Hindi or Hinglish).
Turn the notes into a clear record of the meeting.

Rules:
- Use only what is in the notes and the meeting facts. Never invent a fact, a number, a name, a machine, a date, a price or a promise. A list with nothing in the notes for it stays empty.
- Always write in plain, simple, correct English, also when the notes are in Hindi or Hinglish.
- Never suggest a price, a discount, a change of owner or a change of stage.
- Plain text only: no Markdown.
- "commitments": what either side promised, each starting with who ("We: send the offer by Friday", "Customer: share one month of power data").
- "missingInformation": what a good sales person would still need to know and the notes do not say (budget, who decides, the time line), at most 5.
- "proposedTasks": what OUR side has to do next, each starting with a verb. "dueInDays": days after the meeting, when the notes give a time; otherwise null.
- "budget": what was said about money, in one or two sentences; an empty text when nothing was said.

Answer with one JSON object and nothing else:
{ "summary": "4 to 8 sentences", "clientProblems": [], "machinesDiscussed": [], "technicalRequirements": [], "budget": "", "decisionMakers": [], "competitors": [], "commitments": [], "nextSteps": [], "risks": [], "missingInformation": [], "proposedTasks": [ { "title": "…", "dueInDays": 3 } ] }`;

/**
 * @param {{ meeting: object, notes: string, meetingId: unknown, userId: unknown }} input
 */
export function summarizeMeeting({ meeting, notes, meetingId, userId }) {
  return runAiTask({
    task: 'summarizeMeeting',
    promptVersion: SUMMARIZE_MEETING_VERSION,
    modelClass: 'balanced',
    system: SYSTEM,
    user: JSON.stringify({ meeting, notes }),
    schema: meetingSummarySchema,
    inputRefs: [{ kind: 'meetings', id: meetingId }],
    userId,
    entityType: 'meetings',
    entityId: meetingId,
    maxTokens: 3500,
  });
}
