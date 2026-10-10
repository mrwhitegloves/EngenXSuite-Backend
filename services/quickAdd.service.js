import { Account } from '../models/account.model.js';
import { Contact } from '../models/contact.model.js';
import { logger } from '../infra/logger.js';
import { can } from '../lib/can.js';
import { forbidden } from '../lib/errors.js';
import { createAccount } from './accounts.service.js';
import { createContacts } from './contacts.service.js';
import { createLead } from './opportunities.service.js';

// The "New" form in the top bar: a company, its people and, when wanted, the first lead,
// entered in one go (decision 0013). It uses the same services as the separate screens, so
// every rule (similar-name warning, permissions, phone and email forms, lead code, first
// stage, audit entries, "form filled by") is the same.

/**
 * @param {object} actor
 * @param {{ account: object, contacts: object[], lead?: object }} data  Already validated
 * @param {{ requestId?: string }} [context]
 * @returns {Promise<{ account: object, contacts: object[], lead: object | null }>}
 */
export async function quickAdd(
  actor,
  { account: accountData, contacts: people = [], lead: leadData },
  context = {},
) {
  // Checked before anything is written, so the company is not created and then left alone.
  if (people.length > 0 && !can(actor, 'create', { feature: 'contacts' })) {
    throw forbidden('You do not have permission to add contacts.');
  }
  if (leadData && !can(actor, 'create', { feature: 'opportunities' })) {
    throw forbidden('You do not have permission to add leads.');
  }

  const account = await createAccount(actor, accountData, context);
  try {
    const contacts = await createContacts(actor, account.id, people, context);
    const lead = leadData
      ? await createLead(
          actor,
          // The first person of the form is the lead's main contact.
          { ...leadData, accountId: account.id, primaryContactId: contacts[0]?.id ?? null },
          context,
        )
      : null;
    return { account, contacts, lead };
  } catch (error) {
    // The people or the lead could not be saved: take the brand-new company (and its people)
    // out again, so the form can be corrected and sent once more without a "similar name
    // exists" warning about itself. (Its code is not given to another account; the series
    // simply goes on.)
    await Contact.deleteMany({ accountId: account.id })
      .then(() => Account.deleteOne({ _id: account.id }))
      .catch((cleanupError) => {
        logger.error({ err: cleanupError, accountId: account.id }, 'Quick add: clean-up failed');
      });
    throw error;
  }
}
