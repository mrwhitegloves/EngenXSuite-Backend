import { z } from 'zod';
import { objectId } from './common.js';

export const listDocumentsQuery = z.object({ accountId: objectId });

// Sent as form fields next to the file.
export const uploadDocumentBody = z.object({
  accountId: objectId,
  opportunityId: objectId.optional(),
  name: z.string().trim().min(1).max(200).optional(),
});
