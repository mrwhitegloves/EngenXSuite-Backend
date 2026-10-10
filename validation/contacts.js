import { z } from 'zod';
import { normalizePhone } from '../lib/phone.js';
import { STAKEHOLDER_ROLES } from '../models/contact.model.js';
import { email } from './common.js';
import { tagIds } from './tags.js';

// Short free text. An empty text means "not given" (null).
const text = (max = 120) =>
  z
    .string()
    .trim()
    .max(max, `Use at most ${max} characters`)
    .transform((value) => (value === '' ? null : value))
    .nullable();

// Typed in any usual way; stored in the international form.
const phone = z
  .string()
  .trim()
  .max(30)
  .transform((value) => (value === '' ? null : (normalizePhone(value) ?? 'INVALID')))
  .refine((value) => value !== 'INVALID', 'Enter a phone number with its area code')
  .nullable();

const emptyToNull = z.literal('').transform(() => null);
const oneToFive = z.number().int().min(1).max(5).nullable();

// What a person can fill in about a contact.
export const contactFields = {
  name: z.string().trim().min(1, 'Enter the name').max(120),
  designation: text(),
  department: text(),
  phone_number: phone,
  alt_phone_number: phone,
  email: z.union([emptyToNull, email]).nullable(),
  linkedinUrl: text(300),
  stakeholderRole: z.enum(STAKEHOLDER_ROLES).nullable(),
  decisionPower: oneToFive,
  technicalInfluence: oneToFive,
  commercialInfluence: oneToFive,
  relationshipStrength: oneToFive,
  // Tags chosen from Settings → Tags.
  tagIds,
};

// What the person allowed. Changed only on purpose, so it is its own small object.
const consent = z.object({ whatsappOptIn: z.boolean(), doNotCall: z.boolean() }).partial();

export const updateContactBody = z
  .object({
    ...Object.fromEntries(
      Object.entries(contactFields).map(([key, schema]) => [key, schema.optional()]),
    ),
    consent: consent.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });

export const createContactBody = z.object({
  ...Object.fromEntries(
    Object.entries(contactFields).map(([key, schema]) => [key, schema.optional()]),
  ),
  name: contactFields.name,
});
