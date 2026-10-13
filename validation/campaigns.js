import { z } from 'zod';
import { OPT_OUT_CHANNELS } from '../models/bulkOptOut.model.js';
import { RECIPIENT_STATUSES } from '../models/campaign.model.js';
import { objectId, pagination } from './common.js';

export const listCampaignsQuery = z.object(pagination);
export const listRecipientsQuery = z.object({
  ...pagination,
  status: z.enum(RECIPIENT_STATUSES).optional(),
});

const base = {
  name: z.string().trim().min(1, 'Give the sending a name').max(120),
  bundleId: objectId,
  // Seconds between one person and the next.
  gapSeconds: z.number().int().min(5, 'At least 5 seconds').max(3600, 'At most one hour'),
};

const mail = z
  .object({
    ...base,
    channel: z.literal('email'),
    // ai: the AI writes each mail for its reader. fixed: the same text for everyone.
    writeMode: z.enum(['ai', 'fixed']),
    // What the mails are about (the AI works from this; also used for reminders).
    brief: z.string().trim().max(4000).optional(),
    subject: z.string().trim().max(300).optional(),
    // The fixed text; {{name}} and {{company}} are filled in.
    body: z.string().trim().max(8000).optional(),
    minDaysBeforeReminder: z.number().int().min(0).max(60).default(3),
    // A last line in every mail with a link to stop such mails.
    addStopLine: z.boolean().default(true),
    // Files from Documents that go with every mail.
    attachments: z
      .array(
        z.object({
          url: z.string().url().max(1000),
          filename: z.string().trim().max(200).optional(),
          mimeType: z.string().trim().max(120).optional(),
        }),
      )
      .max(5)
      .optional(),
  })
  .refine((body) => body.writeMode !== 'ai' || (body.brief ?? '').length >= 10, {
    message: 'Say in a sentence or two what the mail is about',
    path: ['brief'],
  })
  .refine((body) => body.writeMode !== 'fixed' || (body.subject && body.body), {
    message: 'Write the subject and the text',
    path: ['body'],
  });

const whatsapp = z.object({
  ...base,
  channel: z.literal('whatsapp'),
  // The name of an approved template, exactly as in Meta, and its language ("en", "en_US", "hi").
  templateName: z
    .string()
    .trim()
    .regex(/^[a-z0-9_]{1,120}$/, 'Use the template name as in Meta: small letters, numbers and _'),
  templateLanguage: z.string().trim().min(2).max(20),
  // The texts for {{1}}, {{2}} … of the template; {{name}} and {{company}} are filled in.
  templateParams: z.array(z.string().trim().min(1).max(500)).max(10).optional(),
});

export const createCampaignBody = z.union([mail, whatsapp]);
// Without a time it starts now; with one it starts by itself at that moment.
export const startCampaignBody = z.object({ at: z.coerce.date().optional() });
// unschedule: a planned sending becomes a draft again.
export const stopCampaignBody = z.object({ action: z.enum(['pause', 'cancel', 'unschedule']) });

// "Do not write to in bulk".
export const listOptOutsQuery = z.object({
  ...pagination,
  search: z.string().trim().max(100).optional(),
  channel: z.enum(OPT_OUT_CHANNELS).optional(),
});
export const addOptOutBody = z.object({
  channel: z.enum(OPT_OUT_CHANNELS),
  // An email address, or a phone number.
  address: z.string().trim().min(3, 'Write the address or the number').max(320),
  note: z.string().trim().max(300).optional(),
});
// The link at the foot of a bulk mail: "<address>.<signature>".
export const stopTokenParams = z.object({
  token: z
    .string()
    .max(700)
    .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'This link is not valid'),
});
export const bundleFromUnsentBody = z.object({
  name: z.string().trim().min(1, 'Give the bundle a name').max(120),
  statuses: z
    .array(z.enum(['failed', 'skipped', 'pending']))
    .min(1)
    .optional(),
});
