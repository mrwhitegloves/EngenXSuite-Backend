import { z } from 'zod';
import { objectId, pagination } from './common.js';

// A field of a multipart form arrives as text; an empty one means "not given".
const optionalId = z.preprocess((value) => (value === '' ? undefined : value), objectId.optional());
const flag = z
  .enum(['1', 'true', '0', 'false'])
  .optional()
  .transform((value) => value === '1' || value === 'true');

export const LIST_VIEWS = ['all', 'unread', 'needs_reply', 'window_open', 'unknown', 'mine'];

export const listConversationsQuery = z.object({
  ...pagination,
  // all: every conversation I may see. unread: with new messages. needs_reply: the customer
  // wrote last. window_open: the customer wrote in the last 24 hours. unknown: a number not in
  // the CRM. mine: assigned to me.
  view: z.enum(LIST_VIEWS).optional(),
  search: z.string().trim().max(100).optional(),
  accountId: objectId.optional(),
  contactId: objectId.optional(),
  // A user's id, or "unassigned".
  assignedTo: z.union([objectId, z.literal('unassigned')]).optional(),
  stageId: objectId.optional(),
  tagId: objectId.optional(),
});

export const threadQuery = z.object({
  // Messages older than this moment (the "Load older messages" button).
  before: z
    .string()
    .max(40)
    .transform((value) => new Date(value))
    .refine((value) => !Number.isNaN(value.getTime()), 'Not a valid date and time')
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const sendTextBody = z.object({
  // WhatsApp's own limit for a text message.
  text: z.string().trim().min(1, 'Write the message').max(4096, 'At most 4096 characters'),
  replyToId: objectId.optional(),
});

export const sendFileBody = z.object({
  caption: z.string().trim().max(1024, 'At most 1024 characters').optional(),
  replyToId: optionalId,
});

export const sendDocumentBody = z.object({
  documentId: objectId,
  caption: z.string().trim().max(1024, 'At most 1024 characters').optional(),
  replyToId: objectId.optional(),
});

export const sendTemplateBody = z.object({
  templateName: z.string().trim().min(1, 'Choose a template').max(512),
  language: z.string().trim().min(2).max(20),
  // The text for each variable of the template: { "1": "Rajesh" } or { first_name: "Rajesh" }.
  values: z
    .record(z.string().regex(/^\w{1,60}$/), z.string().max(1000))
    .refine((values) => Object.keys(values).length <= 30, 'Too many variables')
    .optional(),
  // The file of a template whose header is a picture, a video or a document: one uploaded to
  // this conversation, or a document of the library.
  header: z
    .object({
      url: z.url().max(2000).optional(),
      documentId: objectId.optional(),
      fileName: z.string().trim().max(255).optional(),
      mimeType: z.string().trim().max(120).optional(),
    })
    .refine((header) => Boolean(header.url) !== Boolean(header.documentId), 'Add one file')
    .optional(),
});

export const linkContactBody = z.object({ contactId: objectId });

export const assignBody = z.object({ assignedTo: objectId.nullable() });

export const templatesQuery = z.object({ all: flag, refresh: flag });

export const assistBody = z.object({ kind: z.enum(['suggest', 'summary']) });

// What Meta sends once, when the webhook address is typed into its console.
export const whatsappVerifyQuery = z.object({
  'hub.mode': z.string().max(40).optional(),
  'hub.verify_token': z.string().max(500).optional(),
  'hub.challenge': z.string().max(500).optional(),
});
