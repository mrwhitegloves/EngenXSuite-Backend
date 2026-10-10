import { Contact } from '../models/contact.model.js';
import { PLANT_HEAD_FIELDS, Plant } from '../models/plant.model.js';
import { User } from '../models/user.model.js';
import { SOCKET_EVENTS } from '../constants/socketEvents.js';
import { emitToAll } from '../infra/realtime.js';
import { writeAudit } from '../lib/audit.js';
import { can } from '../lib/can.js';
import { planChanges, toUpdate } from '../lib/changes.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { loadAccountForAction } from './accounts.service.js';
import { assertUsableTags, loadTagsById } from './tags.service.js';

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

function toView(contact, names, tags = new Map()) {
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
    tags: (contact.tagIds ?? []).map((id) => tags.get(String(id))).filter(Boolean),
    decisionPower: contact.decisionPower ?? null,
    technicalInfluence: contact.technicalInfluence ?? null,
    commercialInfluence: contact.commercialInfluence ?? null,
    relationshipStrength: contact.relationshipStrength ?? null,
    consent: {
      whatsappOptIn: contact.consent?.whatsappOptIn ?? false,
      whatsappOptInAt: contact.consent?.whatsappOptInAt ?? null,
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
async function assertNotAlreadyThere(accountId, people, exceptContactId) {
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
  const filter = { accountId, ...NOT_DELETED, $or: filters };
  // When a contact is edited, it is not a duplicate of itself.
  if (exceptContactId) filter._id = { $ne: exceptContactId };
  const existing = await Contact.findOne(filter).select('name').lean();
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
 * @param {{ requestId?: string, importId?: unknown, quiet?: boolean }} [context]
 *        importId: set by the file import. quiet: do not announce the change to open screens.
 *        inbound: set by the inbound-lead flow: { source, ownerId }.
 */
export async function createContacts(actor, accountId, people, context = {}) {
  const account = await loadAccountForAction(actor, accountId, 'view');
  // Nobody to add: nothing to check and nothing to refuse.
  if (people.length === 0) return [];
  if (!can(actor, 'create', { feature: FEATURE })) {
    throw forbidden('You do not have permission to add contacts.');
  }
  await assertNotAlreadyThere(account._id, people);
  for (const person of people) await assertUsableTags(person.tagIds, 'contact');

  const contacts = await Contact.insertMany(
    people.map((person) => ({
      ...given(person),
      accountId: account._id,
      createdBy: actor._id ?? undefined,
      ...(context.importId
        ? { ownerId: actor._id, source: 'import', importId: context.importId }
        : context.inbound
          ? { ownerId: context.inbound.ownerId ?? undefined, source: context.inbound.source }
          : { ownerId: actor._id, source: 'manual', formFilledBy: actor._id }),
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
  if (!context.quiet) emitToAll(SOCKET_EVENTS.contactsChanged);
  const names = await userNames([actor._id]);
  const tags = await loadTagsById(contacts.flatMap((contact) => contact.tagIds ?? []));
  return contacts.map((contact) => toView(contact.toObject(), names, tags));
}

/** The people of one account, by name. */
export async function listAccountContacts(actor, accountId) {
  const account = await loadAccountForAction(actor, accountId, 'view');
  const contacts = await Contact.find({ accountId: account._id, ...NOT_DELETED })
    .sort({ name: 1, _id: 1 })
    .lean();
  const names = await userNames(contacts.map((contact) => contact.formFilledBy));
  const tags = await loadTagsById(contacts.flatMap((contact) => contact.tagIds ?? []));
  return contacts.map((contact) => toView(contact, names, tags));
}

/**
 * Load one contact for an action. A contact of an account the actor may not see answers
 * "not found", exactly like the account itself.
 */
async function loadContactForAction(actor, contactId, action) {
  const contact = await Contact.findOne({ _id: contactId, ...NOT_DELETED }).lean();
  if (!contact) throw notFound('Contact not found');
  // Throws 404 when the account is outside the actor's scope (or deleted).
  await loadAccountForAction(actor, contact.accountId, 'view').catch(() => {
    throw notFound('Contact not found');
  });
  if (!can(actor, action, { feature: FEATURE })) {
    throw forbidden('You do not have permission to do this with contacts.');
  }
  return contact;
}

/**
 * Change a contact. A null value clears a field. Consent changes are recorded with the time.
 * @param {object} actor
 * @param {string} contactId
 * @param {object} changes  Already validated (validation/contacts.js updateContactBody)
 * @param {{ requestId?: string }} [context]
 */
export async function updateContact(actor, contactId, changes, context = {}) {
  const contact = await loadContactForAction(actor, contactId, 'edit');
  const { consent: consentChanges = {}, ...fieldChanges } = changes;

  const plan = planChanges(contact, fieldChanges);
  if (plan.fields.includes('tagIds')) await assertUsableTags(fieldChanges.tagIds, 'contact');
  // The same person entered twice: checked with the values the contact would have afterwards.
  if (plan.fields.some((field) => ['phone_number', 'alt_phone_number', 'email'].includes(field))) {
    await assertNotAlreadyThere(contact.accountId, [{ ...contact, ...fieldChanges }], contact._id);
  }

  const now = new Date();
  const wasOptedIn = contact.consent?.whatsappOptIn ?? false;
  const wasDoNotCall = contact.consent?.doNotCall ?? false;
  if (consentChanges.whatsappOptIn !== undefined && consentChanges.whatsappOptIn !== wasOptedIn) {
    plan.fields.push('consent.whatsappOptIn');
    plan.set['consent.whatsappOptIn'] = consentChanges.whatsappOptIn;
    // When they agreed, and when they withdrew: both moments are kept.
    plan.set[
      consentChanges.whatsappOptIn ? 'consent.whatsappOptInAt' : 'consent.whatsappOptOutAt'
    ] = now;
    plan.oldValue.whatsappOptIn = wasOptedIn;
    plan.newValue.whatsappOptIn = consentChanges.whatsappOptIn;
  }
  if (consentChanges.doNotCall !== undefined && consentChanges.doNotCall !== wasDoNotCall) {
    plan.fields.push('consent.doNotCall');
    plan.set['consent.doNotCall'] = consentChanges.doNotCall;
    plan.oldValue.doNotCall = wasDoNotCall;
    plan.newValue.doNotCall = consentChanges.doNotCall;
  }

  const update = toUpdate(plan);
  if (update) {
    await Contact.updateOne({ _id: contact._id }, update, { runValidators: true });
    await writeAudit({
      actor,
      action: 'contact.updated',
      entityType: 'contacts',
      entityId: contact._id,
      oldValue: plan.oldValue,
      newValue: plan.newValue,
      requestId: context.requestId,
    });
    if (!context.quiet) emitToAll(SOCKET_EVENTS.contactsChanged);
  }
  const saved = await Contact.findById(contact._id).lean();
  return toView(
    saved,
    await userNames([saved.formFilledBy]),
    await loadTagsById(saved.tagIds ?? []),
  );
}

/**
 * Soft delete a contact. Plants that named this person as a head or in their IT/OT team are
 * cleared in the same step, so no plant points at a contact that is gone.
 */
export async function deleteContact(actor, contactId, context = {}) {
  const contact = await loadContactForAction(actor, contactId, 'delete');

  await Contact.updateOne(
    { _id: contact._id },
    { $set: { deletedAt: new Date(), deletedBy: actor._id } },
  );
  for (const field of PLANT_HEAD_FIELDS) {
    await Plant.updateMany({ [field]: contact._id }, { $unset: { [field]: '' } });
  }
  await Plant.updateMany(
    { itOtContactIds: contact._id },
    { $pull: { itOtContactIds: contact._id } },
  );

  await writeAudit({
    actor,
    action: 'contact.deleted',
    entityType: 'contacts',
    entityId: contact._id,
    oldValue: { name: contact.name, accountId: String(contact.accountId) },
    requestId: context.requestId,
  });
  if (context.quiet) return;
  emitToAll(SOCKET_EVENTS.contactsChanged);
  emitToAll(SOCKET_EVENTS.plantsChanged);
}
