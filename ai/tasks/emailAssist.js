import { z } from 'zod';
import { MEETING_MODES } from '../../models/meeting.model.js';
import { runAiTask } from '../runTask.js';

// The AI's smaller helps on customer mail: a summary of a conversation, the tasks in it, a
// meeting it asks for, a check of a mail before it is sent, three versions of a mail, and a
// summary of a file. None of them sends anything or changes a record: a person reads the
// answer and decides.

const lines = (max) => z.array(z.string().trim().min(1).max(400)).max(max);

const COMMON = `Rules:
- Use only what is given. Never invent a fact, a number, a name, a date, a price or a promise.
- Always write in plain, simple, correct English, also when the mail is in Hindi or Hinglish.
- Never suggest a price, a discount, a change of owner or a change of stage.
- Plain text only: no Markdown.`;

const INTRO = `You help a sales person of a company that sells industrial AI, digital transformation and engineering solutions to factories in India.
You get JSON with one email conversation with a customer, oldest mail first. "direction" is "inbound" (the customer wrote) or "outbound" (we wrote).`;

function run({
  task,
  version,
  modelClass = 'fast',
  system,
  input,
  schema,
  threadId,
  userId,
  maxTokens,
}) {
  return runAiTask({
    task,
    promptVersion: version,
    modelClass,
    system,
    user: JSON.stringify(input),
    schema,
    inputRefs: threadId ? [{ kind: 'email_threads', id: threadId }] : [],
    userId,
    entityType: threadId ? 'email_threads' : undefined,
    entityId: threadId,
    maxTokens,
  });
}

// ── A summary of the whole conversation
export const threadSummarySchema = z.object({
  summary: z.string().trim().min(1).max(1500),
  customerAsks: lines(8),
  wePromised: lines(8),
  openQuestions: lines(8),
});

export function summarizeThread({ messages, subject, threadId, userId }) {
  return run({
    task: 'summarizeThread',
    version: 'summarizeThread/v1',
    system: `${INTRO}
Summarize the whole conversation for a colleague who has not read it.

${COMMON}

Answer with one JSON object and nothing else:
{ "summary": "3 to 6 sentences: what it is about and where it stands now", "customerAsks": ["what the customer asked for or wants"], "wePromised": ["what we said we would do or send"], "openQuestions": ["what is still not answered, by either side"] }
Use an empty list where there is nothing.`,
    input: { subject, conversation: messages },
    schema: threadSummarySchema,
    threadId,
    userId,
    maxTokens: 2000,
  });
}

// ── The tasks that follow from the conversation
export const emailTasksSchema = z.object({
  tasks: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        // In how many days from today it should be done; null when the mails do not say.
        dueInDays: z.number().int().min(0).max(365).nullable(),
        reason: z.string().trim().max(300),
      }),
    )
    .max(8),
});

export function extractEmailTasks({ messages, subject, today, threadId, userId }) {
  return run({
    task: 'extractEmailTasks',
    version: 'extractEmailTasks/v1',
    system: `${INTRO}
List what OUR side has to do because of this conversation: what the customer asked us for and we have not done yet, and what we promised and have not done yet. Leave out what is done already (a later mail shows it) and what the customer has to do.

${COMMON}
- "title" starts with a verb: "Send the offer for the pilot".
- "dueInDays": days from "today" until it should be done, worked out from the mails ("by Friday", "next week"); null when the mails give no time.

Answer with one JSON object and nothing else:
{ "tasks": [ { "title": "what to do", "dueInDays": 2, "reason": "one sentence: which mail asks for it" } ] }
An empty list when there is nothing to do.`,
    input: { today, subject, conversation: messages },
    schema: emailTasksSchema,
    threadId,
    userId,
    maxTokens: 1500,
  });
}

// ── A meeting the conversation asks for
export const meetingSuggestionSchema = z.object({
  wantsMeeting: z.boolean(),
  title: z.string().trim().max(200),
  mode: z.enum(MEETING_MODES),
  // India time, "2026-10-16T11:00"; null when no day or time was named.
  startAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    .nullable(),
  durationMinutes: z.number().int().min(15).max(480),
  reason: z.string().trim().max(300),
});

export function suggestMeeting({ messages, subject, today, threadId, userId }) {
  return run({
    task: 'suggestMeeting',
    version: 'suggestMeeting/v1',
    system: `${INTRO}
Say whether the conversation asks for or agrees on a call, a meeting or a plant visit that is still to come, and when.

${COMMON}
- "mode": "online" for a call or video meeting, "plant_visit" for a visit to the customer's plant, "physical" for any other meeting in person.
- "startAt": the day and time that was named, in India time, as "YYYY-MM-DDTHH:mm". Work the day out from "today" ("Friday" = the next Friday). When only a day was named use 11:00. When no day was named: null.
- "durationMinutes": what was said; otherwise 60 (plant visit: 120).
- "title": short, what the meeting is about.

Answer with one JSON object and nothing else:
{ "wantsMeeting": true or false, "title": "…", "mode": "online", "startAt": "2026-10-16T11:00" or null, "durationMinutes": 60, "reason": "one sentence: which mail says it" }`,
    input: { today, subject, conversation: messages },
    schema: meetingSuggestionSchema,
    threadId,
    userId,
    maxTokens: 800,
  });
}

// ── A check of a mail before it goes out
export const emailReviewSchema = z.object({
  isReadyToSend: z.boolean(),
  issues: z
    .array(
      z.object({
        kind: z.enum(['mistake', 'tone', 'unclear', 'missing', 'risk']),
        text: z.string().trim().min(1).max(400),
      }),
    )
    .max(10),
  unansweredQuestions: lines(8),
});

export function reviewEmail({ messages, subject, draft, sender, threadId, userId }) {
  return run({
    task: 'reviewEmail',
    version: 'reviewEmail/v1',
    system: `${INTRO}
You also get "draft": the mail the sales person is about to send, and "sender": that person's full name (their name under the mail is right as it is, short or full). Check the draft before it goes out. Do NOT rewrite it.

Look for:
- "mistake": spelling, grammar, a wrong name, a wrong date, something that contradicts the conversation
- "tone": rude, too casual, too pushy, or too long for what it says
- "unclear": a sentence the customer may not understand, or no clear next step
- "missing": something left to fill in (text in [square brackets]), a file the mail speaks of but may not carry
- "risk": a price, a discount, a date or a promise in the draft that the conversation does not support

${COMMON}
- Each issue: one sentence that says what is wrong and where. Only real issues: an empty list is a good answer.
- "unansweredQuestions": questions of the customer's newest mail that the draft does not answer.
- "isReadyToSend": true when there is no issue of kind mistake, missing or risk, and no unanswered question.

Answer with one JSON object and nothing else:
{ "isReadyToSend": true or false, "issues": [ { "kind": "mistake", "text": "…" } ], "unansweredQuestions": ["…"] }`,
    input: { subject, conversation: messages, sender, draft },
    schema: emailReviewSchema,
    threadId,
    userId,
    maxTokens: 1500,
  });
}

// ── Three versions of one mail
export const emailVariantsSchema = z.object({
  variants: z
    .array(
      z.object({
        label: z.enum(['short', 'detailed', 'formal']),
        body: z.string().trim().min(1).max(8000),
      }),
    )
    .length(3),
});

export function writeEmailVariants({
  mode,
  messages,
  subject,
  sender,
  customer,
  instruction,
  draft,
  threadId,
  userId,
}) {
  return run({
    task: 'writeEmailVariants',
    version: 'writeEmailVariants/v1',
    modelClass: 'balanced',
    system: `${INTRO}
Write the next mail from us in THREE versions, so the sales person can pick one:
- "short": the fewest words that still say everything needed
- "detailed": complete, with the reasons and the next steps spelled out
- "formal": very polite and formal, as to a senior person
"mode" says what the mail is: "reply" (answer the newest customer mail) or "follow_up" (the next mail from us, from everything said so far). "instruction" (may be missing) says what the mail should say. When "currentDraft" is given, all three versions say the same as that draft.

${COMMON}
- Where the mail needs something you do not know, write it in square brackets for the sender to fill in, for example [price] or [date].
- Each version starts with a greeting to the customer by name when it is known, and ends with a closing and the sender's name.

Answer with one JSON object and nothing else:
{ "variants": [ { "label": "short", "body": "…" }, { "label": "detailed", "body": "…" }, { "label": "formal", "body": "…" } ] }`,
    input: {
      mode,
      subject,
      conversation: messages,
      sender,
      customer,
      ...(instruction ? { instruction } : {}),
      ...(draft ? { currentDraft: draft } : {}),
    },
    schema: emailVariantsSchema,
    threadId,
    userId,
    maxTokens: 5000,
  });
}

// ── What a file says
export const documentSummarySchema = z.object({
  summary: z.string().trim().min(1).max(1500),
  keyPoints: lines(10),
  // Numbers, dates, quantities and prices that are in the file, each with what it stands for.
  figures: lines(12),
});

export function summarizeDocument({ name, text, threadId, userId }) {
  return run({
    task: 'summarizeDocument',
    version: 'summarizeDocument/v1',
    system: `You help a sales person of a company that sells industrial AI, digital transformation and engineering solutions to factories in India.
You get JSON with the name and the text of one file that came or went with a customer mail (a drawing, a specification, an offer, a purchase order, a report). Say what it is and what matters in it.

${COMMON}

Answer with one JSON object and nothing else:
{ "summary": "2 to 5 sentences: what kind of file it is and what it says", "keyPoints": ["what matters for the sale"], "figures": ["a number, date, quantity or price from the file, with what it stands for"] }
Use an empty list where there is nothing.`,
    input: { name, text },
    schema: documentSummarySchema,
    threadId,
    userId,
    maxTokens: 2000,
  });
}
