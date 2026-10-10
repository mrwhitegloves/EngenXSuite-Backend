import { Contact } from '../models/contact.model.js';
import { User } from '../models/user.model.js';
import { SOCKET_EVENTS } from '../constants/socketEvents.js';
import { emitToAll } from '../infra/realtime.js';
import { writeAudit } from '../lib/audit.js';
import { can } from '../lib/can.js';
import { conflict, forbidden } from '../lib/errors.js';
import { loadAccountForAction } from './accounts.service.js';

// Contacts: the people at a customer company. A contact is reached through its account:
// whoever may not see the account cannot see its people either (404 from the account check).

const FEATURE = 'contacts';
const NOT_DELETED = { deletedAt: null };

async function userNames(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (unique.length === 0) return new Map();
  const users = await User.find({ _id: { $in: unique } })
    .select('name')
    .lean();
  return new Map(users.map((user) => [String(user._id), user.name]));
}

function toView(contact, names) {
  const person = (id) => (id ? { id: String(id), name: names.get(String(id)) ?? null } : null);
  return {
    id: String(contact._id),
    accountId: String(contact.accountId),
    name: contact.name,
    designation: contact.designation ?? null,
    department: contact.department ?? null,
    phone_number: contact.phone_number ?? null,
    alt_phone_number: contact.alt_phone_number ?? null,
    email: contact.email ?? null,
    linkedinUrl: contact.linkedinUrl ?? null,
    stakeholderRole: contact.stakeholderRole ?? null,
    decisionPower: contact.decisionPower ?? null,
    technicalInfluence: contact.technicalInfluence ?? null,
    commercialInfluence: contact.commercialInfluence ?? null,
    relationshipStrength: contact.relationshipStrength ?? null,
    consent: {
      whatsappOptIn: contact.consent?.whatsappOptIn ?? false,
      doNotCall: contact.consent?.doNotCall ?? false,
    },
    source: contact.source,
    formFilledBy: person(contact.formFilledBy),
    createdAt: contact.createdAt,
  };
}

/** Values that were given: null, undefined and '' are left out, so the field stays unset. */
const given = (data) =>
  Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== null && value !== undefined),
  );

/**
 * The same phone number or email twice among the people of one company is almost always a
 * mistake (the same person entered twice).
 */
async function assertNotAlreadyThere(accountId, people) {
  const phones = people.flatMap((person) => [person.phone_number, person.alt_phone_number]);
  const emails = people.map((person) => person.email);
  const repeated = (values) => {
    const filled = values.filter(Boolean);
    return filled.find((value, index) => filled.indexOf(value) !== index);
  };
  const again = repeated(phones) ?? repeated(emails);
  if (again) throw conflict(`"${again}" is entered for more than one person.`);

  const filters = [];
  const filledPhones = phones.filter(Boolean);
  const filledEmails = emails.filter(Boolean);
  if (filledPhones.length) {
    filters.push(
      { phone_number: { $in: filledPhones } },
      { alt_phone_number: { $in: filledPhones } },
    );
  }
  if (filledEmails.length) filters.push({ email: { $in: filledEmails } });
  if (filters.length === 0) return;
  const existing = await Contact.findOne({ accountId, ...NOT_DELETED, $or: filters })
    .select('name')
    .lean();
  if (existing) {
    throw conflict(
      `This company already has a contact with that phone or email: "${existing.name}".`,
    );
  }
}

/**
 * Add people to an account the actor may see. Used by "add contact" and by the quick-add form.
 * @param {object} actor
 * @param {string} accountId
 * @param {object[]} people  Each already validated (validation/contacts.js createContactBody)
 * @param {{ requestId?: string }} [context]
 */
export async function createContacts(actor, accountId, people, context = {}) {
  const account = await loadAccountForAction(actor, accountId, 'view');
  // Nobody to add: nothing to check and nothing to refuse.
  if (people.length === 0) return [];
  if (!can(actor, 'create', { feature: FEATURE })) {
    throw forbidden('You do not have permission to add contacts.');
  }
  await assertNotAlreadyThere(account._id, people);

  const contacts = await Contact.insertMany(
    people.map((person) => ({
      ...given(person),
      accountId: account._id,
      ownerId: actor._id,
      source: 'manual',
      createdBy: actor._id,
      formFilledBy: actor._id,
    })),
  );
  for (const contact of contacts) {
    await writeAudit({
      actor,
      action: 'contact.created',
      entityType: 'contacts',
      entityId: contact._id,
      newValue: { name: contact.name, accountId: String(account._id) },
      requestId: context.requestId,
    });
  }
  emitToAll(SOCKET_EVENTS.contactsChanged);
  const names = await userNames([actor._id]);
  return contacts.map((contact) => toView(contact.toObject(), names));
}

/** The people of one account, by name. */
export async function listAccountContacts(actor, accountId) {
  const account = await loadAccountForAction(actor, accountId, 'view');
  const contacts = await Contact.find({ accountId: account._id, ...NOT_DELETED })
    .sort({ name: 1, _id: 1 })
    .lean();
  const names = await userNames(contacts.map((contact) => contact.formFilledBy));
  return contacts.map((contact) => toView(contact, names));
}
