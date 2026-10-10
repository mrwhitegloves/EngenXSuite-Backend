import { z } from 'zod';
import { createAccountBody } from './accounts.js';
import { createContactBody } from './contacts.js';
import { createLeadBody } from './opportunities.js';

// The "New" form in the top bar: a company, up to 10 of its people and, when wanted, the first
// lead, in one go. The lead belongs to the new company; its main contact is the first person.
export const quickAddBody = z.object({
  account: createAccountBody,
  contacts: z.array(createContactBody).max(10, 'At most 10 people at once').default([]),
  lead: createLeadBody.omit({ accountId: true, primaryContactId: true }).optional(),
});
