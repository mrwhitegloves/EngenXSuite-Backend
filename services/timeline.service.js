import { writeAudit } from '../lib/audit.js';
import { can } from '../lib/can.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { runListQuery } from '../lib/queryBuilder.js';
import { scopeFilter } from '../lib/scopeFilter.js';
import { Activity } from '../models/activity.model.js';
import { Contact } from '../models/contact.model.js';
import { Opportunity } from '../models/opportunity.model.js';
import { User } from '../models/user.model.js';
import { SOCKET_EVENTS } from '../constants/socketEvents.js';
import { emitToAll } from '../infra/realtime.js';
import { loadAccountForAction } from './accounts.service.js';
import { recordActivity } from './activities.service.js';
import { loadLeadForAction } from './opportunities.service.js';

// Reading the timeline, and notes (the entries a person writes by hand).
//
// A timeline is always asked for ONE record: a company, a lead or a contact. The record is
// loaded with the usual access check first, so a timeline is never shown to someone who may
// not see the record itself. A company's timeline also holds the entries of its leads; those
// of a lead the person may not see are left out (lead access rule, decision 0008).

const NOT_DELETED = { deletedAt: null };

/**
 * Check the record a timeline or a note belongs to, and answer the links to store or filter on.
 * @param {object} actor
 * @param {{ accountId?: string, opportunityId?: string, contactId?: string }} target  Exactly one
 * @param {'view' | 'edit'} action  "edit" to write a note
 */
async function resolveTarget(actor, target, action) {
  const given = ['accountId', 'opportunityId', 'contactId'].filter((key) => target[key]);
  if (given.length !== 1) {
    throw badRequest('Say which company, lead or contact this is about (exactly one).');
  }
  if (target.opportunityId) {
    const lead = await loadLeadForAction(actor, target.opportunityId, action);
    return { kind: 'lead', links: { opportunityId: lead._id, accountId: lead.accountId } };
  }
  if (target.accountId) {
    const account = await loadAccountForAction(actor, target.accountId, action);
    return { kind: 'account', links: { accountId: account._id } };
  }
  const contact = await Contact.findOne({ _id: target.contactId, ...NOT_DELETED }).lean();
  if (!contact) throw notFound('Contact not found');
  // A contact is reached through its company (404 when that is outside the person's scope).
  await loadAccountForAction(actor, contact.accountId, 'view').catch(() => {
    throw notFound('Contact not found');
  });
  if (!can(actor, action, { feature: 'contacts' })) {
    throw forbidden('You do not have permission to do this with contacts.');
  }
  return { kind: 'contact', links: { contactId: contact._id, accountId: contact.accountId } };
}

/** Entries of leads the person may not see are hidden from a company's or contact's timeline. */
async function visibleLeadsFilter(actor, accountId) {
  const scope = scopeFilter(actor, 'opportunities');
  if (Object.keys(scope).length === 0) return {};
  const visible = await Opportunity.distinct('_id', { $and: [scope, { accountId }] });
  return { $or: [{ opportunityId: null }, { opportunityId: { $in: visible } }] };
}

function toView(activity, lookups, actor) {
  const person = (id) => {
    const user = id && lookups.users.get(String(id));
    return user ? { id: String(user._id), name: user.name } : null;
  };
  const lead = activity.opportunityId && lookups.leads.get(String(activity.opportunityId));
  const contact = activity.contactId && lookups.contacts.get(String(activity.contactId));
  const isMine = activity.userId && String(activity.userId) === String(actor._id);
  return {
    id: String(activity._id),
    type: activity.type,
    subtype: activity.subtype ?? null,
    direction: activity.direction ?? null,
    title: activity.title,
    content: activity.content ?? null,
    status: activity.status ?? null,
    occurredAt: activity.occurredAt,
    editedAt: activity.editedAt ?? null,
    user: person(activity.userId),
    lead: lead ? { id: String(lead._id), name: lead.name, leadCode: lead.leadCode } : null,
    contact: contact ? { id: String(contact._id), name: contact.name } : null,
    metadata: activity.metadata ?? null,
    // A note can be changed or removed by the person who wrote it.
    canEdit: activity.type === 'NOTE' && Boolean(isMine),
  };
}

async function loadLookups(activities) {
  const ids = (pick) => [...new Set(activities.map(pick).filter(Boolean).map(String))];
  const byId = (items) => new Map(items.map((item) => [String(item._id), item]));
  const [users, leads, contacts] = await Promise.all([
    User.find({ _id: { $in: ids((item) => item.userId) } })
      .select('name')
      .lean(),
    Opportunity.find({ _id: { $in: ids((item) => item.opportunityId) } })
      .select('name leadCode')
      .lean(),
    Contact.find({ _id: { $in: ids((item) => item.contactId) } })
      .select('name')
      .lean(),
  ]);
  return { users: byId(users), leads: byId(leads), contacts: byId(contacts) };
}

/**
 * The timeline of one company, lead or contact, newest first.
 * @param {{ accountId?: string, opportunityId?: string, contactId?: string, type?: string,
 *           page: number, pageSize: number }} query  Validated
 */
export async function listTimeline(actor, query) {
  const { kind, links } = await resolveTarget(actor, query, 'view');
  const conditions = [];
  if (kind === 'lead') conditions.push({ opportunityId: links.opportunityId });
  else {
    conditions.push(
      kind === 'account' ? { accountId: links.accountId } : { contactId: links.contactId },
      await visibleLeadsFilter(actor, links.accountId),
    );
  }
  if (query.type) conditions.push({ type: query.type });

  const { rows, pagination } = await runListQuery(Activity, {
    filter: { $and: conditions.filter((condition) => Object.keys(condition).length > 0) },
    sort: { occurredAt: -1, _id: -1 },
    page: query.page,
    pageSize: query.pageSize,
  });
  const lookups = await loadLookups(rows);
  return { items: rows.map((row) => toView(row, lookups, actor)), pagination };
}

/**
 * Write a note on a company, a lead or a contact. Whoever may edit the record may write on it.
 * @param {{ accountId?: string, opportunityId?: string, contactId?: string, content: string }} data
 */
export async function addNote(actor, data, context = {}) {
  const { links } = await resolveTarget(actor, data, 'edit');
  const note = await recordActivity({
    type: 'NOTE',
    direction: 'internal',
    title: 'Note',
    content: data.content,
    userId: actor._id,
    ...links,
  });
  await writeAudit({
    actor,
    action: 'note.created',
    entityType: 'activities',
    entityId: note._id,
    newValue: { content: data.content },
    requestId: context.requestId,
  });
  return toView(note, await loadLookups([note]), actor);
}

/** A note of the acting person; anything else is "not found". */
async function loadOwnNote(actor, noteId) {
  const note = await Activity.findOne({ _id: noteId, type: 'NOTE', userId: actor._id }).lean();
  if (!note) throw notFound('Note not found');
  return note;
}

/** Change the text of one's own note. The timeline shows that it was edited. */
export async function updateNote(actor, noteId, { content }, context = {}) {
  const note = await loadOwnNote(actor, noteId);
  if (note.content !== content) {
    await Activity.updateOne({ _id: note._id }, { $set: { content, editedAt: new Date() } });
    await writeAudit({
      actor,
      action: 'note.updated',
      entityType: 'activities',
      entityId: note._id,
      oldValue: { content: note.content },
      newValue: { content },
      requestId: context.requestId,
    });
    emitToAll(SOCKET_EVENTS.activitiesChanged);
  }
  const saved = await Activity.findById(note._id).lean();
  return toView(saved, await loadLookups([saved]), actor);
}

/** Remove one's own note. Its text stays readable in the audit log. */
export async function deleteNote(actor, noteId, context = {}) {
  const note = await loadOwnNote(actor, noteId);
  await Activity.deleteOne({ _id: note._id });
  await writeAudit({
    actor,
    action: 'note.deleted',
    entityType: 'activities',
    entityId: note._id,
    oldValue: { content: note.content },
    requestId: context.requestId,
  });
  emitToAll(SOCKET_EVENTS.activitiesChanged);
}
