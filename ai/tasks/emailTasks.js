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

export const WRITE_EMAIL_VERSION = 'writeEmail/v1';

export const writtenEmailSchema = z.object({
  // For a new mail: its subject. Inside a conversation: the conversation's subject, unchanged.
  subject: z.string().trim().max(300),
  // The whole text, ready to be read and changed: greeting, body, closing.
  body: z.string().trim().min(1).max(8000),
});

const WRITE_SYSTEM = `You write business email for a sales person of a company that sells industrial AI, digital transformation and engineering solutions to factories in India.
You get JSON with:
- "mode": "reply" (answer the newest customer message of the conversation), "follow_up" (write the next mail in the conversation from everything said in it so far, for example a reminder or the next step), or "new" (a first mail on a new subject).
- "conversation": the mails so far, oldest first ("inbound" = the customer wrote, "outbound" = we wrote); empty for a new mail.
- "sender": who the mail is from. "customer": what the CRM knows about them.
- "instruction": what the sender wants from this mail (may be missing).
- "currentDraft": the mail as it stands now (may be missing).

How to work:
- When "currentDraft" is given, the instruction says what to CHANGE. Change exactly that and keep everything else as it is, word for word.
- When there is no draft, write the mail for the mode, following the instruction.

Rules:
- Use only what is in the conversation and the CRM facts. Never invent a fact, a number, a date, a price, a delivery time, a feature or a promise. Where the mail needs something you do not know, write it in square brackets for the sender to fill in, for example [price] or [date].
- Never state a price or a discount, and never commit to a date, unless it is in the conversation already.
- "customer.lead" and "customer.earlierConversations" (one line for each earlier conversation: its subject and what its last mail says) tell you only what was talked ABOUT. Never say or suggest that something was agreed, done, delivered, installed, started or is running, and never thank the customer for something, unless a mail or one of these lines says it happened.
- Plain, simple, correct, polite business English. Short paragraphs. No filler, no flattery. Write in English also when the customer wrote in Hindi or Hinglish, unless the instruction asks for another language.
- Start with a greeting to the customer by name when it is known. End with a closing and the sender's name.
- Plain text only: no Markdown.
- "subject": for "new", a short, plain subject. For "reply" and "follow_up", give back the conversation's subject unchanged.

Answer with one JSON object and nothing else:
{ "subject": "the subject", "body": "the whole text of the mail" }`;

/**
 * @param {{ mode: string, messages: object[], sender: string, customer: object, subject?: string,
 *           instruction?: string, draft?: { subject?: string, body: string }, threadId?: unknown,
 *           accountId?: unknown, userId: unknown }} input
 */
export function writeEmail({
  mode,
  messages,
  sender,
  customer,
  subject,
  instruction,
  draft,
  threadId,
  accountId,
  userId,
}) {
  return runAiTask({
    task: 'writeEmail',
    promptVersion: WRITE_EMAIL_VERSION,
    modelClass: 'balanced',
    system: WRITE_SYSTEM,
    user: JSON.stringify({
      mode,
      ...(subject ? { conversationSubject: subject } : {}),
      conversation: messages,
      sender,
      customer,
      ...(instruction ? { instruction } : {}),
      ...(draft ? { currentDraft: draft } : {}),
    }),
    schema: writtenEmailSchema,
    inputRefs: [
      threadId ? { kind: 'email_threads', id: threadId } : { kind: 'accounts', id: accountId },
    ],
    userId,
    entityType: threadId ? 'email_threads' : 'accounts',
    entityId: threadId ?? accountId,
    maxTokens: 3500,
  });
}
