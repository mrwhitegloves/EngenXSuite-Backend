import { z } from 'zod';
import { email, objectId, pagination } from './common.js';

export const listThreadsQuery = z.object({
  ...pagination,
  // all: every conversation I may see. waiting: the customer wrote last. mine: my own mailbox.
  view: z.enum(['all', 'waiting', 'mine']).optional(),
  search: z.string().trim().max(100).optional(),
  accountId: objectId.optional(),
  opportunityId: objectId.optional(),
});

export const sendEmailBody = z
  .object({
    // An answer inside this conversation. Without it: a new mail.
    threadId: objectId.optional(),
    to: z.array(email).max(20).optional(),
    cc: z.array(email).max(20).optional(),
    subject: z.string().trim().max(300).optional(),
    text: z.string().trim().min(1, 'Write the mail').max(50000),
  })
  .refine((body) => body.threadId || (body.to?.length && body.subject), {
    message: 'A new mail needs a recipient and a subject',
    path: ['to'],
  });

export const draftBody = z.object({
  // How the answer should be ("short", "ask for a call on Friday").
  instruction: z.string().trim().max(1000).optional(),
});
