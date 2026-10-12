import { z } from 'zod';
import { DUPLICATE_MODES, IMPORT_TARGETS } from '../models/import.model.js';
import { LEAD_SOURCES } from '../models/opportunity.model.js';
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

// For a file with lead columns (see models/import.model.js).
const leadOptions = z
  .object({
    source: z.enum(LEAD_SOURCES),
    noLeadColumn: z.string().max(200),
    noLeadValues: z.array(z.string().trim().min(1).max(200)).max(20),
  })
  .partial()
  .optional();

const templateName = z.string().trim().min(1, 'Enter a name').max(60, 'Use at most 60 characters');

export const listImportsQuery = z.object({ ...pagination });

// Sent as form fields next to the file.
export const uploadImportBody = z.object({
  targetType: z.enum(IMPORT_TARGETS).default('accounts'),
});

export const previewImportBody = z.object({
  mapping,
  duplicateMode: z.enum(DUPLICATE_MODES),
  leadOptions,
});

export const startImportBody = z.object({
  mapping,
  duplicateMode: z.enum(DUPLICATE_MODES),
  leadOptions,
  // Save this mapping under a name for the next file of the same shape.
  saveTemplateAs: templateName.optional(),
});

export const saveTemplateBody = z.object({
  name: templateName,
  targetType: z.enum(IMPORT_TARGETS).default('accounts'),
  mapping,
});
