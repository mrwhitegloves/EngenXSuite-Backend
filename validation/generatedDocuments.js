import { z } from 'zod';
import { MAX_DOCUMENT_DATA_BYTES, MAX_PDF_HTML_BYTES } from '../constants/generatedDocuments.js';
import { pagination, sortBy } from './common.js';

// Input rules of /api/generator/<kind> (Document generator).

// The template's values: any JSON object (the client template decides its fields), limited in size.
const data = z
  .record(z.string(), z.unknown())
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value)) <= MAX_DOCUMENT_DATA_BYTES,
    'The document is too large to save',
  );

const fields = {
  templateKey: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{2,60}$/, 'Unknown template'),
  title: z.string().trim().min(1, 'Enter a title').max(200),
  refNo: z.string().trim().max(80).default(''),
  clientName: z.string().trim().max(200).default(''),
  data,
};

export const createGeneratedBody = z.strictObject(fields);

export const updateGeneratedBody = z
  .strictObject({
    title: fields.title.optional(),
    refNo: z.string().trim().max(80).optional(),
    clientName: z.string().trim().max(200).optional(),
    data: data.optional(),
    // The time of the copy the person edited: a newer save by someone else is never overwritten.
    updatedAt: z.string().datetime().optional(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== 'updatedAt'), 'Nothing to change');

export const listGeneratedQuery = z.object({
  search: z.string().trim().max(100).optional(),
  sort: sortBy(['title', 'createdAt', 'updatedAt']),
  ...pagination,
});

// One-click PDF: the finished page and the file name to give it.
export const generatorPdfBody = z.strictObject({
  html: z
    .string()
    .min(50, 'Nothing to print')
    .refine((value) => Buffer.byteLength(value) <= MAX_PDF_HTML_BYTES, 'The document is too large'),
  fileName: z.string().trim().min(1).max(150),
});
