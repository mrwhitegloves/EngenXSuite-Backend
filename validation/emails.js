import { z } from 'zod';
import { email, objectId, pagination } from './common.js';

export const listThreadsQuery = z.object({
  ...pagination,
  // all: every conversation I may see. waiting: the customer wrote last. mine: my own mailbox.
  view: z.enum(['all', 'waiting', 'mine', 'follow_up']).optional(),
  search: z.string().trim().max(100).optional(),
  accountId: objectId.optional(),
  opportunityId: objectId.optional(),
  contactId: objectId.optional(),
});

// A file to send: one the person just picked, or one from a mail they may see.
const attachmentRef = z.object({
  url: z.string().url().max(1000),
  filename: z.string().trim().max(200).optional(),
  mimeType: z.string().trim().max(120).optional(),
});

export const accountFilesQuery = z.object({ accountId: objectId });

export const writeWithAiBody = z
  .object({
    mode: z.enum(['reply', 'follow_up', 'new']),
    threadId: objectId.optional(),
    accountId: objectId.optional(),
    contactId: objectId.optional(),
    // What the mail should say or, with a draft, what to change in it.
    instruction: z.string().trim().max(2000).optional(),
    draft: z
      .object({ subject: z.string().max(300).optional(), body: z.string().min(1).max(8000) })
      .optional(),
  })
  .refine((body) => body.threadId || body.accountId, {
    message: 'Say which conversation or which company the mail is for',
    path: ['threadId'],
  });

export const sendEmailBody = z
  .object({
    // An answer inside this conversation. Without it: a new mail.
    threadId: objectId.optional(),
    to: z.array(email).max(20).optional(),
    cc: z.array(email).max(20).optional(),
    subject: z.string().trim().max(300).optional(),
    text: z.string().trim().min(1, 'Write the mail').max(50000),
    attachments: z.array(attachmentRef).max(10).optional(),
  })
  .refine((body) => body.threadId || (body.to?.length && body.subject), {
    message: 'A new mail needs a recipient and a subject',
    path: ['to'],
  });

export const draftBody = z.object({
  // How the answer should be ("short", "ask for a call on Friday").
  instruction: z.string().trim().max(1000).optional(),
});

// One of the AI's helps on a conversation (services/emailAssist.service.js).
export const assistBody = z.object({
  kind: z.enum(['summary', 'tasks', 'meeting', 'review', 'variants']),
  // The mail on the screen: checked ("review"), or said again in three versions ("variants").
  draft: z.string().trim().max(8000).optional(),
  instruction: z.string().trim().max(2000).optional(),
  mode: z.enum(['reply', 'follow_up']).optional(),
});

// A file of a mail, by its own address.
export const fileSummaryBody = z.object({ url: z.string().url().max(1000) });
