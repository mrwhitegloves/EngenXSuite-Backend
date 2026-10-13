import { z } from 'zod';
import { objectId, pagination } from './common.js';

const name = z.string().trim().min(1, 'Give the bundle a name').max(120);
// Who to put in: whole companies (their people, their own address, or both) and single people.
const pick = {
  accountIds: z.array(objectId).max(2000).optional(),
  contactIds: z.array(objectId).max(2000).optional(),
  includePeople: z.boolean().optional(),
  includeCompany: z.boolean().optional(),
};

export const listBundlesQuery = z.object({
  ...pagination,
  search: z.string().trim().max(100).optional(),
});
export const bundleMembersQuery = z.object(pagination);
export const createBundleBody = z.object({ name, ...pick });
export const renameBundleBody = z.object({ name });
export const addMembersBody = z
  .object(pick)
  .refine((body) => body.accountIds?.length || body.contactIds?.length, {
    message: 'Choose who to add',
  });
export const candidatesQuery = z.object({ search: z.string().trim().min(2).max(100) });
export const memberParams = z.object({ id: objectId, memberId: objectId });
