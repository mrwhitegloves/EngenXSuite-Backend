import { SOCKET_EVENTS } from '../constants/socketEvents.js';
import { env } from '../config/env.js';
import { logger } from '../infra/logger.js';
import { emitToAll } from '../infra/realtime.js';
import {
  fetchMetaFormName,
  fetchMetaLead,
  isMetaLeadsConfigured,
} from '../integrations/meta/leadAds.js';
import { writeAudit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { canonicalFieldName, normalizeInboundFields } from '../lib/fieldNames.js';
import { toNameKey } from '../lib/nameKey.js';
import { runListQuery } from '../lib/queryBuilder.js';
import { systemActor } from '../lib/systemActor.js';
import { Account } from '../models/account.model.js';
import { Contact } from '../models/contact.model.js';
import { InboundLead, LEAD_FORM_FIELDS, LeadForm } from '../models/inboundLead.model.js';
import { Opportunity } from '../models/opportunity.model.js';
import { SolutionCategory } from '../models/solutionCategory.model.js';
import { User } from '../models/user.model.js';
import { createAccountBody } from '../validation/accounts.js';
import { createContactBody } from '../validation/contacts.js';
import { createAccount } from './accounts.service.js';
import { recordActivity, recordSystemActivity } from './activities.service.js';
import { createContacts } from './contacts.service.js';
import { pickLeadOwner } from './leadAssignment.service.js';
import { notify } from './notifications.service.js';
import { createLead } from './opportunities.service.js';
import { createTask } from './tasks.service.js';
import { registerWebhookProcessor } from './webhooks.service.js';

// Inbound leads: what happens when someone fills in a Meta lead ad form (REQ-LED-001 … 008).
//
//   1. Meta calls our webhook with the lead's id. The webhook receiver stores the event and
//      answers at once (services/webhooks.service.js); a background job then calls this file.
//   2. The enquiry is stored in `leads` as received, and its answers are fetched from Meta.
//   3. The answers are mapped to CRM fields: by the form's mapping (Settings → Lead forms), and
//      by name where that is clear (email, phone, full name, company). The rest becomes a note.
//   4. The same person again (same phone or email, with a lead that is still open) is noted on
//      that lead as a repeat enquiry. Otherwise a company, a person and a lead are created
//      through the normal services, with source "Meta ads".
//   5. The lead gets an owner by the assignment rule; the owner is notified and gets a first
//      follow-up task.
//
// Every step can run twice: the Meta lead id is unique, and what was already created for an
// enquiry is remembered on it and reused.

const SOURCE = 'meta_ads';
const SOURCE_LABEL = 'Meta ads';
const NOT_DELETED = { deletedAt: null };
const FIRST_TASK_DUE_MS = 60 * 60 * 1000;
const announce = () => emitToAll(SOCKET_EVENTS.inboundLeadsChanged);

// Meta's standard question names (and the usual ways custom questions are named) → CRM field.
const KNOWN_QUESTIONS = {
  full_name: 'contact.name',
  name: 'contact.name',
  company_name: 'account.name',
  company: 'account.name',
  organisation: 'account.name',
  organization: 'account.name',
  job_title: 'contact.designation',
  designation: 'contact.designation',
  city: 'account.hq.city',
  state: 'account.hq.state',
  website: 'account.website',
  industry: 'account.industry',
};
const questionKey = (name) =>
  String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

/**
 * Turn the answers of a form into CRM fields.
 * @param {{ name: string, value: string }[]} answers
 * @param {{ question: string, crmField: string }[]} fieldMapping  The form's own mapping
 * @returns {{ mapped: Record<string, string>, notes: string[] }}
 *          notes: "Question: answer" for every answer that fills no field
 */
export function mapAnswers(answers, fieldMapping = []) {
  const chosen = new Map(fieldMapping.map((item) => [item.question, item.crmField]));
  const mapped = {};
  const notes = [];
  const names = {};
  for (const { name, value } of answers) {
    const text = String(value ?? '').trim();
    if (!text) continue;
    const key = questionKey(name);
    if (key === 'first_name' || key === 'last_name') names[key] = text;

    let field = chosen.get(name);
    if (!field) {
      const kind = canonicalFieldName(name);
      field =
        KNOWN_QUESTIONS[key] ??
        (kind === 'email'
          ? 'contact.email'
          : kind === 'phone_number'
            ? 'contact.phone_number'
            : null);
    }
    if (field === 'ignore' || key === 'first_name' || key === 'last_name') continue;
    // The first answer for a field wins; a second one is kept as a note, never lost.
    if (field && mapped[field] === undefined) mapped[field] = text;
    else notes.push(`${name}: ${text}`);
  }
  if (!mapped['contact.name'] && (names.first_name || names.last_name)) {
    mapped['contact.name'] = [names.first_name, names.last_name].filter(Boolean).join(' ');
  }
  // Email and phone in their one stored form (decision 0013).
  const tidy = normalizeInboundFields({
    email: mapped['contact.email'],
    phone_number: mapped['contact.phone_number'],
  }).fields;
  if (tidy.email) mapped['contact.email'] = tidy.email;
  if (tidy.phone_number) mapped['contact.phone_number'] = tidy.phone_number;
  return { mapped, notes };
}

/** The part of the mapped answers that starts with "contact." or "account." as an object. */
function partOf(mapped, prefix) {
  const part = {};
  for (const [field, value] of Object.entries(mapped)) {
    if (!field.startsWith(prefix)) continue;
    const path = field.slice(prefix.length).split('.');
    if (path.length === 1) part[path[0]] = value;
    else part[path[0]] = { ...part[path[0]], [path[1]]: value };
  }
  return part;
}

/**
 * Check a part with the form's own validation. An answer that does not pass (a phone number
 * that is not one) is taken out and kept as a note, so one bad answer never loses the lead.
 */
function validPart(schema, data, notes) {
  let current = { ...data };
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const parsed = schema.safeParse(current);
    if (parsed.success) return parsed.data;
    const field = parsed.error.issues[0].path[0];
    if (field === undefined || field === 'name') break;
    notes.push(`${field} (as typed): ${JSON.stringify(current[field])}`);
    current = Object.fromEntries(Object.entries(current).filter(([key]) => key !== field));
  }
  throw badRequest('The answers of this lead could not be read.');
}

async function loadForm(formExternalId, pageId, answers) {
  const filter = { source: SOURCE, externalFormId: String(formExternalId) };
  let form = await LeadForm.findOne(filter).lean();
  if (!form) {
    const name = (await fetchMetaFormName(formExternalId)) ?? `Form ${formExternalId}`;
    form = await LeadForm.findOneAndUpdate(
      filter,
      { $setOnInsert: { name, pageId } },
      { upsert: true, returnDocument: 'after' },
    ).lean();
  }
  // Remember the questions seen, for the mapping screen.
  const questions = answers.map((answer) => answer.name).filter(Boolean);
  await LeadForm.updateOne({ _id: form._id }, { $addToSet: { questions: { $each: questions } } });
  return form;
}

/** Keep on the enquiry what was made for it, so a second run reuses it. */
async function remember(inbound, fields) {
  // Only what has a value: an answer the form did not have must not wipe a field.
  const given = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined && value !== null),
  );
  Object.assign(inbound, given);
  if (Object.keys(given).length > 0) {
    await InboundLead.updateOne({ _id: inbound._id }, { $set: given });
  }
}

/** The same person enquiring again while their lead is still open: note it, tell the owner. */
async function noteRepeatEnquiry(inbound, contact, openLead, form) {
  const first = await InboundLead.findOne({ opportunityId: openLead._id, status: 'processed' })
    .sort({ receivedAt: 1 })
    .lean();
  if (first) {
    await InboundLead.updateOne(
      { _id: first._id },
      {
        $push: {
          repeatEnquiries: {
            source: SOURCE,
            formName: form.name,
            campaignName: inbound.campaign?.campaignName,
            externalId: inbound.externalId,
            at: inbound.receivedAt,
          },
        },
        $inc: { duplicateCount: 1 },
        $set: { lastDuplicateAt: inbound.receivedAt },
      },
    );
  }
  await recordSystemActivity({
    subtype: 'lead_enquired_again',
    opportunityId: openLead._id,
    accountId: openLead.accountId,
    contactId: contact._id,
    occurredAt: inbound.receivedAt,
    title: `Enquired again through ${SOURCE_LABEL}: ${form.name}`,
    content: inbound.unmappedNote || undefined,
    refCollection: 'leads',
    refId: inbound._id,
  });
  await notify({
    userId: openLead.ownerId,
    type: 'lead_received',
    title: `Enquired again: ${contact.name}`,
    body: `${SOURCE_LABEL} · ${form.name}`,
    link: `/pipeline/${openLead._id}`,
    dedupeKey: `lead-received:${inbound._id}`,
  });
  await remember(inbound, {
    status: 'duplicate',
    contactId: contact._id,
    accountId: openLead.accountId,
    opportunityId: openLead._id,
    assignedTo: openLead.ownerId ?? undefined,
  });
}

/** Steps 2 to 5 for one stored enquiry. */
async function convert(inbound, { formExternalId, pageId }) {
  const actor = systemActor();
  const meta = await fetchMetaLead(inbound.externalId);
  const form = await loadForm(meta.formId ?? formExternalId, pageId, meta.answers);
  const { mapped, notes } = mapAnswers(meta.answers, form.fieldMapping);
  const sourceDetail = {
    campaign: meta.campaign.campaignName ?? undefined,
    adSet: meta.campaign.adSetName ?? undefined,
    ad: meta.campaign.adName ?? undefined,
    form: form.name,
  };
  await remember(inbound, {
    formId: form._id,
    campaign: { ...meta.campaign, pageId, formName: form.name },
    metaCreatedAt: meta.createdTime ?? undefined,
    rawFields: meta.answers,
    mapped,
    phone_number: mapped['contact.phone_number'],
    email: mapped['contact.email'],
  });

  if (!form.isActive) {
    await remember(inbound, {
      status: 'processed',
      error: 'This form is switched off: the enquiry is stored, nothing was created.',
    });
    return;
  }

  const personData = partOf(mapped, 'contact.');
  const companyData = partOf(mapped, 'account.');
  const phone = personData.phone_number;
  const email = personData.email;
  const displayName = personData.name || companyData.name || email || phone;
  if (!displayName) {
    throw badRequest(
      'This lead has no name, phone, email or company. Map the form’s questions in Settings → Lead forms.',
    );
  }
  const context = { quiet: true };
  const inboundRef = { source: SOURCE, leadId: inbound._id, sourceDetail };

  // The same person before? By phone or email, whichever company they are under.
  const matches = [phone && { phone_number: phone }, email && { email }].filter(Boolean);
  let contact =
    (inbound.contactId && (await Contact.findById(inbound.contactId).lean())) ||
    (matches.length > 0
      ? await Contact.findOne({ ...NOT_DELETED, $or: matches })
          .sort({ createdAt: 1 })
          .lean()
      : null);
  if (contact && !inbound.opportunityId) {
    const openLead = await Opportunity.findOne({
      ...NOT_DELETED,
      status: 'open',
      $or: [{ primaryContactId: contact._id }, { accountId: contact.accountId }],
    })
      .sort({ createdAt: -1 })
      .lean();
    if (openLead) {
      await remember(inbound, { unmappedNote: notes.join('\n') || undefined });
      await noteRepeatEnquiry(inbound, contact, openLead, form);
      return;
    }
  }

  const ownerId = inbound.assignedTo ?? (await pickLeadOwner({ formOwnerId: form.defaultOwnerId }));
  if (ownerId && !inbound.assignedTo) await remember(inbound, { assignedTo: ownerId });

  // The company: the person's existing one, one with the same name, or a new one. Someone who
  // names no company gets a company of their own name (an individual enquirer).
  let accountId = inbound.accountId ?? contact?.accountId;
  if (!accountId) {
    const companyName = companyData.name || personData.name || displayName;
    const existing = companyData.name
      ? await Account.findOne({ ...NOT_DELETED, nameKey: toNameKey(companyData.name) })
          .select('_id')
          .lean()
      : null;
    if (existing) accountId = existing._id;
    else {
      const data = validPart(createAccountBody, { ...companyData, name: companyName }, notes);
      const account = await createAccount(
        actor,
        { ...data, ownerId: ownerId ? String(ownerId) : null, confirmDuplicate: true },
        { ...context, inbound: inboundRef },
      );
      accountId = account.id;
    }
    await remember(inbound, { accountId });
  }

  if (!contact) {
    const data = validPart(
      createContactBody,
      { ...personData, name: personData.name || displayName },
      notes,
    );
    const [created] = await createContacts(actor, accountId, [data], {
      ...context,
      inbound: { source: SOURCE, ownerId },
    });
    contact = { _id: created.id, name: created.name };
    await remember(inbound, { contactId: contact._id });
  }

  let leadId = inbound.opportunityId;
  if (!leadId) {
    const category =
      form.defaultSolutionCategoryId &&
      (await SolutionCategory.exists({ _id: form.defaultSolutionCategoryId, isActive: true }));
    const lead = await createLead(
      actor,
      {
        name: `${displayName} · ${form.name}`.slice(0, 200),
        accountId: String(accountId),
        primaryContactId: String(contact._id),
        ownerId: ownerId ? String(ownerId) : null,
        source: SOURCE,
        ...(mapped['lead.requirement'] ? { requirement: mapped['lead.requirement'] } : {}),
        ...(category ? { solutionCategoryIds: [String(form.defaultSolutionCategoryId)] } : {}),
      },
      { via: 'automation', inbound: { leadId: inbound._id, sourceDetail } },
    );
    leadId = lead.id;
    await remember(inbound, { opportunityId: leadId });
  }

  const note = notes.join('\n');
  await remember(inbound, { unmappedNote: note || undefined });
  await recordSystemActivity({
    subtype: 'lead_received',
    opportunityId: leadId,
    contactId: contact._id,
    occurredAt: inbound.receivedAt,
    title: `Lead received from ${SOURCE_LABEL}: ${form.name}`,
    content:
      [
        sourceDetail.campaign && `Campaign: ${sourceDetail.campaign}`,
        sourceDetail.ad && `Ad: ${sourceDetail.ad}`,
      ]
        .filter(Boolean)
        .join('\n') || undefined,
    refCollection: 'leads',
    refId: inbound._id,
  });
  if (note) {
    // The answers that fill no field, readable on the lead's timeline.
    await recordActivity({
      type: 'NOTE',
      direction: 'inbound',
      subtype: 'form_answers',
      opportunityId: leadId,
      contactId: contact._id,
      occurredAt: inbound.receivedAt,
      title: 'More answers from the form',
      content: note.slice(0, 5000),
      refCollection: 'leads',
      refId: inbound._id,
    });
  }

  if (ownerId) {
    await notify({
      userId: ownerId,
      type: 'lead_received',
      title: `New lead: ${displayName}`,
      body: `${SOURCE_LABEL} · ${form.name}`,
      link: `/pipeline/${leadId}`,
      dedupeKey: `lead-received:${inbound._id}`,
    });
    // The first follow-up. One per enquiry: a second run finds it there already.
    await createTask(
      actor,
      {
        title: `Call the new lead: ${displayName}`.slice(0, 200),
        type: 'follow_up',
        priority: 'high',
        dueAt: new Date(Date.now() + FIRST_TASK_DUE_MS),
        assigneeId: String(ownerId),
        opportunityId: String(leadId),
      },
      { origin: { source: 'lead', sourceRef: { from: 'leads', id: inbound._id } } },
    ).catch((error) => {
      if (error?.code !== 11000) throw error;
    });
  }
  await remember(inbound, { status: 'processed' });
  // A reason left by an earlier failed try no longer applies.
  await InboundLead.updateOne({ _id: inbound._id }, { $unset: { error: '' } });
}

/**
 * Handle one Meta lead: store it and turn it into a company, a person and a lead.
 * Safe to call twice for the same lead id.
 * @param {{ leadgenId: string, formExternalId?: string, pageId?: string }} event
 */
export async function processMetaLead({ leadgenId, formExternalId, pageId }, webhookEventId) {
  const inbound = await InboundLead.findOneAndUpdate(
    { externalId: String(leadgenId) },
    {
      $setOnInsert: {
        source: SOURCE,
        status: 'received',
        receivedAt: new Date(),
        webhookEventId: webhookEventId ?? undefined,
      },
    },
    { upsert: true, returnDocument: 'after' },
  ).lean();
  if (['processed', 'duplicate'].includes(inbound.status)) return inbound;

  try {
    await convert(inbound, { formExternalId, pageId });
  } catch (error) {
    const reason = error?.isAppError ? error.message : 'A system problem stopped this lead.';
    if (!error?.isAppError) logger.error({ err: error, leadgenId }, 'Inbound lead failed');
    await InboundLead.updateOne(
      { _id: inbound._id },
      { $set: { status: 'failed', error: String(reason).slice(0, 500) } },
    );
    announce();
    throw error;
  }
  // One announcement for everything the lead created.
  for (const event of ['accountsChanged', 'contactsChanged', 'opportunitiesChanged']) {
    emitToAll(SOCKET_EVENTS[event]);
  }
  announce();
  return InboundLead.findById(inbound._id).lean();
}

/**
 * The processor of Meta's webhook events. One event can carry several leads.
 * @param {{ _id: unknown, payload: object }} event  A stored webhook event
 */
async function processMetaWebhookEvent(event) {
  const leads = (event.payload?.entry ?? []).flatMap((entry) =>
    (entry.changes ?? [])
      .filter((change) => change.field === 'leadgen' && change.value?.leadgen_id)
      .map((change) => ({
        leadgenId: String(change.value.leadgen_id),
        formExternalId: change.value.form_id ? String(change.value.form_id) : undefined,
        pageId: String(change.value.page_id ?? entry.id ?? ''),
      })),
  );
  let firstError = null;
  for (const lead of leads) {
    // One lead that fails must not hold back the others of the same event.
    await processMetaLead(lead, event._id).catch((error) => {
      firstError ??= error;
    });
  }
  // Passed on, so the event is marked failed and the queue tries again (finished leads are skipped).
  if (firstError) throw firstError;
}
registerWebhookProcessor('meta_leads', processMetaWebhookEvent);

// ── What the settings screens read and change ───────────────────────────────────────────────

/** Whether Meta lead ads are set up, and what is missing (names of settings only). */
export function getMetaSetup() {
  const needed = ['META_APP_SECRET', 'META_VERIFY_TOKEN', 'META_PAGE_ACCESS_TOKEN'];
  return {
    isConfigured: isMetaLeadsConfigured(),
    missing: needed.filter((name) => !env[name]),
    // The address to give Meta: this path on the public address of the server.
    webhookPath: '/api/webhooks/meta/leads',
  };
}

function toFormView(form, names) {
  const named = (map, id) =>
    id && map.get(String(id)) ? { id: String(id), name: map.get(String(id)) } : null;
  const chosen = new Map(form.fieldMapping.map((item) => [item.question, item.crmField]));
  return {
    id: String(form._id),
    name: form.name,
    source: form.source,
    externalFormId: form.externalFormId,
    isActive: form.isActive,
    // Every question seen on the form, with the field it fills ('' = decided by its name).
    questions: form.questions.map((question) => ({
      question,
      crmField: chosen.get(question) ?? '',
      // What happens without a choice, so the screen can say it.
      automatic: mapAnswers([{ name: question, value: 'x' }]).notes.length === 0,
    })),
    defaultOwner: named(names.users, form.defaultOwnerId),
    defaultSolutionCategory: named(names.categories, form.defaultSolutionCategoryId),
  };
}

export async function listLeadForms() {
  const [forms, users, categories] = await Promise.all([
    LeadForm.find().sort({ name: 1 }).lean(),
    User.find({ status: 'active' }).select('name').sort({ name: 1 }).lean(),
    SolutionCategory.find({ isActive: true }).select('name').sort({ order: 1 }).lean(),
  ]);
  const nameMap = (items) => new Map(items.map((item) => [String(item._id), item.name]));
  const names = { users: nameMap(users), categories: nameMap(categories) };
  const option = (item) => ({ id: String(item._id), name: item.name });
  return {
    setup: getMetaSetup(),
    forms: forms.map((form) => toFormView(form, names)),
    fields: Object.entries(LEAD_FORM_FIELDS).map(([field, label]) => ({ field, label })),
    users: users.map(option),
    solutionCategories: categories.map(option),
  };
}

/**
 * Change a form: its mapping, its owner, its default solution, on or off.
 * @param {{ fieldMapping?: object[], defaultOwnerId?: string | null,
 *           defaultSolutionCategoryId?: string | null, isActive?: boolean }} changes  Validated
 */
export async function updateLeadForm(actor, formId, changes, context = {}) {
  const form = await LeadForm.findById(formId).lean();
  if (!form) throw notFound('Form not found');
  if (
    changes.defaultOwnerId &&
    !(await User.exists({ _id: changes.defaultOwnerId, status: 'active' }))
  ) {
    throw badRequest('Choose an active user', [{ field: 'defaultOwnerId' }]);
  }
  const set = {};
  const unset = {};
  for (const [field, value] of Object.entries(changes)) {
    if (value === null) unset[field] = '';
    else set[field] = value;
  }
  await LeadForm.updateOne(
    { _id: form._id },
    {
      ...(Object.keys(set).length ? { $set: set } : {}),
      ...(Object.keys(unset).length ? { $unset: unset } : {}),
    },
    { runValidators: true },
  );
  await writeAudit({
    actor,
    action: 'lead_form.updated',
    entityType: 'lead_forms',
    entityId: form._id,
    newValue: changes,
    requestId: context.requestId,
  });
  announce();
  return (await listLeadForms()).forms.find((item) => item.id === String(form._id));
}

/** The enquiries as they arrived, newest first; `status` narrows it (for example "failed"). */
export async function listInboundLeads({ status, page, pageSize }) {
  const { rows, pagination } = await runListQuery(InboundLead, {
    filter: status ? { status } : {},
    sort: { receivedAt: -1, _id: -1 },
    page,
    pageSize,
    select: '-rawFields',
  });
  return {
    items: rows.map((row) => ({
      id: String(row._id),
      source: row.source,
      status: row.status,
      receivedAt: row.receivedAt,
      name: row.mapped?.['contact.name'] ?? row.mapped?.['account.name'] ?? null,
      phone_number: row.phone_number ?? null,
      email: row.email ?? null,
      formName: row.campaign?.formName ?? null,
      campaignName: row.campaign?.campaignName ?? null,
      opportunityId: row.opportunityId ? String(row.opportunityId) : null,
      repeatCount: row.duplicateCount ?? 0,
      error: row.error ?? null,
    })),
    pagination,
  };
}

/** Try a failed (or never finished) enquiry again. */
export async function retryInboundLead(actor, inboundId, context = {}) {
  const inbound = await InboundLead.findById(inboundId).lean();
  if (!inbound) throw notFound('Lead not found');
  if (!['failed', 'received'].includes(inbound.status)) {
    throw conflict('This lead was processed already.');
  }
  await writeAudit({
    actor,
    action: 'inbound_lead.retried',
    entityType: 'leads',
    entityId: inbound._id,
    requestId: context.requestId,
  });
  const result = await processMetaLead({
    leadgenId: inbound.externalId,
    pageId: inbound.campaign?.pageId,
  });
  return {
    status: result.status,
    opportunityId: result.opportunityId ? String(result.opportunityId) : null,
  };
}
