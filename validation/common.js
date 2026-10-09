import { z } from 'zod';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../infra/password.js';

// Building blocks reused by the validation schemas of every feature.

export const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Not a valid id');

export const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('Enter a valid email address').max(254));

// A password someone is choosing. (Sign-in uses a looser check: see validation/auth.js.)
export const newPassword = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(MAX_PASSWORD_LENGTH, 'Password is too long');

// Indian and international numbers, stored in E.164 form (+919876543210).
export const phone = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, 'Use the international format, for example +919876543210');

// A web address of a picture. Only https, so the page never loads mixed or script content.
export const imageUrl = z
  .string()
  .trim()
  .max(500)
  .pipe(
    z
      .url('Enter a full web address')
      .startsWith('https://', 'The address must start with https://'),
  );

export const idParams = z.object({ id: objectId });

// Every list endpoint accepts these (Master Prompt Section 74).
export const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};
