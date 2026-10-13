import { z } from 'zod';
import { objectId } from './common.js';

// One folder of the library (none: the top), or a search through all of it.
export const browseDocumentsQuery = z.object({
  folderId: objectId.optional(),
  search: z.string().trim().min(1).max(100).optional(),
});

// Sent as form fields next to the file.
export const uploadDocumentBody = z.object({
  folderId: objectId.optional(),
  name: z.string().trim().min(1).max(200).optional(),
});

// Rename, or move to another folder (null: to the top).
export const updateDocumentBody = z
  .object({
    name: z.string().trim().min(1, 'Give it a name').max(200).optional(),
    folderId: objectId.nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });

const folderName = z.string().trim().min(1, 'Give the folder a name').max(80);
export const createFolderBody = z.object({ name: folderName, parentId: objectId.optional() });
export const renameFolderBody = z.object({ name: folderName });
