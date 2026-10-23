import { z } from 'zod';
import { runAiTask } from '../runTask.js';

// The AI's helps on a WhatsApp chat: "What should I say?" and a summary. Only on a person's
// click; nothing is sent or changed: a person reads the answer, edits it and presses Send.
//
// Language (founder, 2026-10-23): the texts meant for the customer (the reply and the
// questions to ask) follow the customer's language, also Hindi or Hinglish. Everything meant
// for our sales person (labels, tips, the summary) is plain, simple, correct English.

const INTRO = `You help a sales person of a company that sells industrial AI, digital transformation and engineering solutions to factories in India.
You get JSON with one WhatsApp chat with a customer, oldest message first. "from" is "customer" or "us". "kind" is the kind of message (text, image, document, template …); a file shows only its caption or name.`;

const COMMON = `Rules:
- Use only what is given. Never invent a fact, a number, a name, a date, a price or a promise.
- Never offer or mention a price, a discount, a change of owner or a change of stage.
- Plain text only: no Markdown. WhatsApp style: short, friendly, professional.`;

function run({ task, version, system, input, schema, conversationId, userId, maxTokens }) {
  return runAiTask({
    task,
    promptVersion: version,
    modelClass: 'fast',
    system,
    user: JSON.stringify(input),
    schema,
    inputRefs: [{ kind: 'whatsapp_conversations', id: conversationId }],
    userId,
    entityType: 'whatsapp_conversations',
    entityId: conversationId,
    maxTokens,
  });
}

// ── "What should I say?"
export const whatsappSuggestionSchema = z.object({
  reply: z.string().trim().min(1).max(2000),
  ask: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(80),
        text: z.string().trim().min(1).max(500),
      }),
    )
    .max(2),
  next: z
    .object({
      label: z.string().trim().min(1).max(80),
      text: z.string().trim().min(1).max(500),
    })
    .nullable(),
  tips: z
    .array(
      z.object({
        said: z.string().trim().min(1).max(300),
        answer: z.string().trim().min(1).max(400),
      }),
    )
    .max(3),
});

export function suggestWhatsAppReply({ messages, customer, sender, conversationId, userId }) {
  return run({
    task: 'suggestWhatsAppReply',
    version: 'suggestWhatsAppReply/v1',
    system: `${INTRO}
You also get "customer" (person, role, company, industry, the open lead and its stage, when known) and "sender": the first name of our sales person who will send the reply.
Help the sales person answer the customer's newest messages.

${COMMON}
- "reply": one full reply to the customer's newest message(s), ready to send. Write it in the SAME language and script the customer writes in: English → English; Hindi in Devanagari → Hindi in Devanagari; Hinglish (Hindi in Latin letters) → Hinglish. Correct spelling and grammar. 1 to 4 short sentences. Answer what they asked; when a fact is not given, say we will check and come back.
- "ask": at most two short questions that would help the sale and are not answered in the chat yet (for example their plant, machines, the problem, timeline, who decides). "label" in English (for example "Ask about the plant"); "text" is the question to send, in the customer's language.
- "next": the next step to propose (a call, a meeting, a plant visit, sending a document), or null when it is too early. "label" in English; "text" to send, in the customer's language.
- "tips": at most three doubts or objections the customer raised, each with how to answer. Both "said" and "answer" in plain, simple English. Empty when there are none.

Answer with one JSON object and nothing else:
{ "reply": "…", "ask": [ { "label": "…", "text": "…" } ], "next": { "label": "…", "text": "…" } or null, "tips": [ { "said": "…", "answer": "…" } ] }`,
    input: { customer, sender, chat: messages },
    schema: whatsappSuggestionSchema,
    conversationId,
    userId,
    maxTokens: 1500,
  });
}

// ── A summary of the chat
const lines = (max) => z.array(z.string().trim().min(1).max(400)).max(max);

export const whatsappSummarySchema = z.object({
  summary: z.string().trim().min(1).max(1500),
  customerAsks: lines(8),
  wePromised: lines(8),
  openQuestions: lines(8),
  nextStep: z.string().trim().max(400).nullable(),
});

export function summarizeWhatsAppChat({ messages, customer, conversationId, userId }) {
  return run({
    task: 'summarizeWhatsAppChat',
    version: 'summarizeWhatsAppChat/v1',
    system: `${INTRO}
You also get "customer": who the customer is, when known.
Summarize the chat for a colleague who has not read it.

${COMMON}
- Always write in plain, simple, correct English, also when the chat is in Hindi or Hinglish.

Answer with one JSON object and nothing else:
{ "summary": "3 to 6 sentences: what it is about and where it stands now", "customerAsks": ["what the customer asked for or wants"], "wePromised": ["what we said we would do or send"], "openQuestions": ["what is still not answered, by either side"], "nextStep": "the most useful next step for us, or null" }
Use an empty list where there is nothing.`,
    input: { customer, chat: messages },
    schema: whatsappSummarySchema,
    conversationId,
    userId,
    maxTokens: 1500,
  });
}
