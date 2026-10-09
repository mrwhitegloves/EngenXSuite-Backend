import { z } from 'zod';

// Plain names: no line breaks or other control characters (they end up in page titles, emails
// and PDF headers).
const plainName = (max, label) =>
  z
    .string()
    .trim()
    .min(1, `Enter the ${label}`)
    .max(max, `Use at most ${max} characters`)
    // eslint-disable-next-line no-control-regex
    .regex(/^[^\u0000-\u001f\u007f]*$/, 'Use plain text on one line');

export const updateBrandingBody = z
  .object({
    productName: plainName(60, 'product name').optional(),
    companyName: plainName(120, 'company name').optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });
