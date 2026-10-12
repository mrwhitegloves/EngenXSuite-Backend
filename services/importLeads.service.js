import { badRequest } from '../lib/errors.js';
import { Opportunity } from '../models/opportunity.model.js';
import { PipelineStage } from '../models/pipelineStage.model.js';
import { LeadStatus } from '../models/statusLists.model.js';
import { createLead, deleteLead } from './opportunities.service.js';
import { moveToStage } from './stage.service.js';
import { addNote } from './timeline.service.js';

// The lead part of a file import. A row of a file with lead columns becomes a lead of the
// row's company and person, through the normal services (createLead, the stage service, the
// timeline), as the person who imports: they become its owner.

const NOT_DELETED = { deletedAt: null };
const keyOf = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
// Lead statuses (by their fixed key) that mean the lead is over: it is closed in the "lost"
// stage of the pipeline, with the status kept.
const CLOSING_STATUS_KEYS = ['lost', 'notinterested'];

/**
 * What is needed to save leads, read once per import: the lead statuses by name, and the
 * stage that closes a lead as lost.
 */
export async function loadLeadImportContext() {
  const [statuses, lostStage] = await Promise.all([
    LeadStatus.find({ isActive: { $ne: false } }).lean(),
    PipelineStage.findOne({ type: 'lost', isActive: true }).lean(),
  ]);
  return {
    statusByName: new Map(statuses.map((status) => [keyOf(status.name), status])),
    lostStage,
  };
}

/**
 * Does this row get a lead? Not when the import says "no lead for rows where this column has
 * one of these values" (a list bought from a data provider inside a sheet of real enquiries).
 * @param {{ headers: string[], leadOptions?: { noLeadColumn?: string, noLeadValues?: string[] } }} item
 */
export function rowGetsLead(item, cells) {
  const { noLeadColumn, noLeadValues = [] } = item.leadOptions ?? {};
  if (!noLeadColumn || noLeadValues.length === 0) return true;
  const value = keyOf(cells[item.headers.indexOf(noLeadColumn)]);
  return !noLeadValues.map(keyOf).includes(value);
}

/** What is wrong with a row's lead before anything is saved; null when it can be saved. */
export function leadProblem(lead, context) {
  if (lead.status && !context.statusByName.has(keyOf(lead.status))) {
    return `Lead status "${lead.status}" is not in Settings → Statuses`;
  }
  return null;
}

/** What the lead is about, when the file has no column for it. */
const nameOf = (lead, companyName) =>
  lead.name ??
  ((lead.campaign ?? lead.form)
    ? `${lead.campaign ?? lead.form} enquiry`
    : `Enquiry from ${companyName}`);

/**
 * Save the lead of one row.
 * @param {{ accountId: unknown, contactId?: unknown, companyName: string, lead: object }} row
 * @returns {Promise<'created' | 'exists'>}  exists: this enquiry, or an open lead of this
 *          person, is in the CRM already (importing a file twice makes no second lead)
 */
export async function saveImportedLead(actor, item, rowNumber, row, context) {
  const { accountId, contactId, companyName, lead } = row;
  const problem = leadProblem(lead, context);
  if (problem) throw badRequest(problem);

  const same = [
    lead.externalId && { 'sourceDetail.externalId': lead.externalId },
    contactId && { primaryContactId: contactId, status: 'open' },
  ].filter(Boolean);
  if (same.length && (await Opportunity.exists({ ...NOT_DELETED, $or: same }))) return 'exists';

  const status = lead.status ? context.statusByName.get(keyOf(lead.status)) : null;
  const sourceDetail = Object.fromEntries(
    ['campaign', 'adSet', 'ad', 'form', 'externalId']
      .filter((key) => lead[key])
      .map((key) => [key, String(lead[key]).slice(0, 200)]),
  );
  const created = await createLead(
    actor,
    {
      name: nameOf(lead, companyName).slice(0, 150),
      accountId: String(accountId),
      ...(contactId ? { primaryContactId: String(contactId) } : {}),
      ...(status ? { leadStatusId: String(status._id) } : {}),
      source: item.leadOptions?.source ?? 'import',
      requirement: lead.requirement,
      problemStatement: lead.problemStatement,
      decisionTimeline: lead.decisionTimeline,
    },
    {
      importId: item._id,
      importRow: rowNumber,
      quiet: true,
      via: 'import',
      imported: { sourceDetail, createdAt: lead.createdAt },
    },
  );

  // The form's other answers as one note, then the comments, oldest first.
  const notes = [
    lead.answers.length
      ? `Answers from the lead form:\n${lead.answers.map((item) => `- ${item.question} ${item.answer}`).join('\n')}`
      : null,
    ...lead.notes,
  ].filter(Boolean);
  for (const content of notes) {
    await addNote(actor, { opportunityId: created.id, content: content.slice(0, 5000) });
  }

  // "Lost" and "Not interested": the lead is closed, with the last comment as the reason.
  if (status && CLOSING_STATUS_KEYS.includes(keyOf(status.key)) && context.lostStage) {
    const saved = await Opportunity.findById(created.id).lean();
    await moveToStage(actor, saved, {
      stageId: String(context.lostStage._id),
      closeReason: (lead.notes.at(-1) ?? `Marked "${status.name}" before the import.`).slice(
        0,
        500,
      ),
      via: 'import',
    });
  }
  return 'created';
}

/** The undo of an import: the leads it created, removed with the usual rules. */
export async function removeImportedLeads(actor, importId, onEach) {
  const leads = await Opportunity.find({ importId, ...NOT_DELETED })
    .select('_id')
    .lean();
  let removed = 0;
  let kept = 0;
  for (const lead of leads) {
    try {
      await deleteLead(actor, lead._id, { quiet: true });
      removed += 1;
    } catch {
      kept += 1;
    }
    await onEach?.();
  }
  return { removed, kept };
}
