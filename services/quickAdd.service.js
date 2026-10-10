import { Account } from '../models/account.model.js';
import { logger } from '../infra/logger.js';
import { can } from '../lib/can.js';
import { forbidden } from '../lib/errors.js';
import { createAccount } from './accounts.service.js';
import { createContacts } from './contacts.service.js';

// The "New" form in the top bar: a company and its people entered in one go (decision 0013).
// It uses the same two services as the separate screens, so every rule (similar-name warning,
// permissions, phone and email forms, audit entries, "form filled by") is the same.

/**
 * @param {object} actor
 * @param {{ account: object, contacts: object[] }} data  Already validated
 * @param {{ requestId?: string }} [context]
 * @returns {Promise<{ account: object, contacts: object[] }>}
 */
export async function quickAdd(
  actor,
  { account: accountData, contacts: people = [] },
  context = {},
) {
  // Checked before anything is written, so the company is not created and then left alone.
  if (people.length > 0 && !can(actor, 'create', { feature: 'contacts' })) {
    throw forbidden('You do not have permission to add contacts.');
  }

  const account = await createAccount(actor, accountData, context);
  try {
    const contacts = await createContacts(actor, account.id, people, context);
    return { account, contacts };
  } catch (error) {
    // The people could not be saved: take the brand-new company out again, so the form can be
    // corrected and sent once more without a "similar name exists" warning about itself.
    // (Its code is not given to another account; the series simply goes on.)
    await Account.deleteOne({ _id: account.id }).catch((cleanupError) => {
      logger.error({ err: cleanupError, accountId: account.id }, 'Quick add: clean-up failed');
    });
    throw error;
  }
}
