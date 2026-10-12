import { z } from 'zod';
import { EMAIL_CATEGORIES } from '../../models/email.model.js';
import { runAiTask } from '../runTask.js';

// AI tasks on customer mail: say what a conversation is and whether it needs an answer, and
// draft an answer for the person to read, change and send. Neither sends anything, and
// neither changes a record of the CRM.

export const CLASSIFY_EMAIL_VERSION = 'classifyEmail/v1';
export const DRAFT_REPLY_VERSION = 'draftReply/v1';

export const emailClassSchema = z.object({
  category: z.enum(EMAIL_CATEGORIES),
  // The customer is waiting for an answer from us.
  needsReply: z.boolean(),
  // One or two sentences: what the customer says or wants.
  summary: z.string().trim().min(1).max(600),
  // The one thing the sales person should do now; empty when nothing is needed.
  suggestedAction: z.string().trim().max(300),
});

const CLASSIFY_SYSTEM = `You read business email for a company that sells industrial AI, digital transformation and engineering solutions to factories in India.
You get one email conversation with a customer as JSON, oldest message first. "direction" is "inbound" (the customer wrote) or "outbound" (we wrote).
Say what the NEWEST customer message is, and whether we owe an answer.

Categories:
- enquiry: asks about what we offer, a first contact
- quotation_request: asks for a price, a quote or a proposal
- follow_up: continues something under way (a reply, a reminder, a status question)
- meeting_request: asks for, confirms or moves a call, a meeting or a visit
- complaint: is unhappy about something
- information: tells us something, no question
- other: none of these (a newsletter, an automatic message)

Rules:
- Use only what is in the conversation. Never invent a fact, a number, a name or a date.
- "needsReply" is true only when the newest message is from the customer and asks or expects something from us.
- Always write in plain, simple, correct English, also when the mail is in Hindi or Hinglish.
- Never suggest a price, a discount, a change of owner or a change of stage.

Answer with one JSON object and nothing else:
{ "category": "one of the categories", "needsReply": true or false, "summary": "1 or 2 sentences", "suggestedAction": "one step for the sales person, or an empty text" }`;

/**
 * @param {{ messages: object[], threadId: unknown, userId?: unknown }} input
 *        messages: { direction, from, date, text } oldest first, already cut to size
 */
export function classifyEmail({ messages, threadId, userId }) {
  return runAiTask({
    task: 'classifyEmail',
    promptVersion: CLASSIFY_EMAIL_VERSION,
    modelClass: 'fast',
    system: CLASSIFY_SYSTEM,
    user: JSON.stringify({ conversation: messages }),
    schema: emailClassSchema,
    inputRefs: [{ kind: 'email_threads', id: threadId }],
    userId,
    entityType: 'email_threads',
    entityId: threadId,
    maxTokens: 1200,
  });
}

export const draftReplySchema = z.object({
  // The text of the answer, ready to be read and changed: greeting, body, closing. No subject.
  body: z.string().trim().min(1).max(6000),
});

const DRAFT_SYSTEM = `You draft email answers for a sales person of a company that sells industrial AI, digital transformation and engineering solutions to factories in India.
You get JSON with: the conversation (oldest first; "inbound" = the customer wrote, "outbound" = we wrote), who writes the answer ("sender"), what the CRM knows about the customer ("customer"), and sometimes how the sender wants the answer ("instruction").
Write the answer to the newest customer message.

Rules:
- Use only what is in the conversation and the CRM facts. Never invent a fact, a number, a date, a price, a delivery time, a feature or a promise. Where the answer needs something you do not know, write it in square brackets for the sender to fill in, for example [price] or [date].
- Never state a price or a discount, and never commit to a date, unless it is in the conversation already.
- Plain, simple, correct, polite business English. Short paragraphs. No filler, no flattery. Write in English also when the customer wrote in Hindi or Hinglish, unless the instruction asks for another language.
- Start with a greeting to the customer by name when it is known. End with a closing and the sender's name.
- Plain text only: no Markdown, no subject line.

Answer with one JSON object and nothing else:
{ "body": "the text of the answer" }`;

/**
 * @param {{ messages: object[], sender: string, customer: object, instruction?: string,
 *           threadId: unknown, userId: unknown }} input
 */
export function draftReply({ messages, sender, customer, instruction, threadId, userId }) {
  return runAiTask({
    task: 'draftReply',
    promptVersion: DRAFT_REPLY_VERSION,
    modelClass: 'balanced',
    system: DRAFT_SYSTEM,
    user: JSON.stringify({
      conversation: messages,
      sender,
      customer,
      ...(instruction ? { instruction } : {}),
    }),
    schema: draftReplySchema,
    inputRefs: [{ kind: 'email_threads', id: threadId }],
    userId,
    entityType: 'email_threads',
    entityId: threadId,
    maxTokens: 3000,
  });
}
