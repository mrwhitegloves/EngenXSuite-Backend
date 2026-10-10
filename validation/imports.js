import { z } from 'zod';
import { DUPLICATE_MODES, IMPORT_TARGETS } from '../models/import.model.js';
import { pagination } from './common.js';

// Which column fills which field. Whether the columns and fields exist is checked in the
// service, against the file (services/importRows.service.js toColumns).
const mapping = z
  .array(
    z.object({
      column: z.string().min(1).max(200),
      field: z.string().min(1).max(60),
    }),
  )
  .min(1, 'Choose a field for at least one column')
  .max(100);

const templateName = z.string().trim().min(1, 'Enter a name').max(60, 'Use at most 60 characters');

export const listImportsQuery = z.object({ ...pagination });

// Sent as form fields next to the file.
export const uploadImportBody = z.object({
  targetType: z.enum(IMPORT_TARGETS).default('accounts'),
});

export const previewImportBody = z.object({
  mapping,
  duplicateMode: z.enum(DUPLICATE_MODES),
});

export const startImportBody = z.object({
  mapping,
  duplicateMode: z.enum(DUPLICATE_MODES),
  // Save this mapping under a name for the next file of the same shape.
  saveTemplateAs: templateName.optional(),
});

export const saveTemplateBody = z.object({
  name: templateName,
  targetType: z.enum(IMPORT_TARGETS).default('accounts'),
  mapping,
});
