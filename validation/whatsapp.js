import { z } from 'zod';
import { objectId, pagination } from './common.js';

export const listConversationsQuery = z.object({
  ...pagination,
  // all: every conversation I may see. unread: with new messages. mine: assigned to me.
  view: z.enum(['all', 'unread', 'mine']).optional(),
  search: z.string().trim().max(100).optional(),
  accountId: objectId.optional(),
});

export const sendTextBody = z.object({
  text: z.string().trim().min(1, 'Write the message').max(4000),
});

export const assignBody = z.object({ assignedTo: objectId.nullable() });

// What Meta sends once, when the webhook address is typed into its console.
export const whatsappVerifyQuery = z.object({
  'hub.mode': z.string().max(40).optional(),
  'hub.verify_token': z.string().max(500).optional(),
  'hub.challenge': z.string().max(500).optional(),
});
