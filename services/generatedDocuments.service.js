import { GeneratedDocument } from '../models/generatedDocument.model.js';
import { GENERATED_KINDS, REF_SERIES } from '../constants/generatedDocuments.js';
import { buildFilter, buildSort, runListQuery } from '../lib/queryBuilder.js';
import { scopeFilter } from '../lib/scopeFilter.js';
import { can } from '../lib/can.js';
import { conflict, createAppError, forbidden, notFound } from '../lib/errors.js';
import { writeAudit } from '../lib/audit.js';

// The Document generator (founder, 2026-11-12): proposals, letter heads and invoices made from
// a client template and saved with their filled-in values.
// Rules:
// - each kind is one permission feature (constants/generatedDocuments.js); its scope (own /
//   team / all) is checked against the person who made the document (`ownerId`);
// - a document outside the person's view scope answers 404, so its existence is not revealed;
// - a save based on an older copy is refused (409), so nobody overwrites a colleague's work;
// - kinds with a REF_SERIES get the next reference suggested by nextRefNo(); two documents never
//   share a reference of that series (409 REF_TAKEN with the next free one);
// - every create, change and delete is audited (only the title and reference, not the text).

const SORTS = { title: 'title', createdAt: 'createdAt', updatedAt: 'updatedAt' };
const OWNER = { ownerField: 'ownerId' };

const featureOf = (kind) => GENERATED_KINDS[kind].feature;
const entityType = 'generated_documents';

function toSummary(doc) {
  return {
    id: String(doc._id),
    kind: doc.kind,
    templateKey: doc.templateKey,
    title: doc.title,
    refNo: doc.refNo ?? '',
    clientName: doc.clientName ?? '',
    ownerId: String(doc.ownerId),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

const toView = (doc) => ({ ...toSummary(doc), data: doc.data ?? {} });

/**
 * One document for an action. Outside the user's view scope: 404. Visible but the action is not
 * allowed on it: 403.
 */
async function loadForAction(actor, kind, id, action) {
  const doc = await GeneratedDocument.findOne({ _id: id, kind }).lean();
  const resource = { feature: featureOf(kind), record: doc, ...OWNER };
  if (!doc || !can(actor, 'view', resource))
    throw notFound(`${GENERATED_KINDS[kind].label} not found`);
  if (action !== 'view' && !can(actor, action, resource)) {
    throw forbidden(
      `You do not have permission to do this with this ${GENERATED_KINDS[kind].label.toLowerCase()}.`,
    );
  }
  return doc;
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const yearInIndia = (now) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric' }).format(now);

/**
 * The next free reference of a kind's series this year, e.g. "ENGENX-DMA-2026-101": one more than
 * the highest number used so far (by anyone, whatever the asker's scope), at least `first`.
 * Only a suggestion: the number is taken when the document is saved (see assertRefFree).
 * @returns {Promise<string>} '' for a kind without a series
 */
export async function nextRefNo(kind, now = new Date()) {
  const series = REF_SERIES[kind];
  if (!series) return '';
  const start = `${series.prefix}-${yearInIndia(now)}-`;
  const used = await GeneratedDocument.find(
    { kind, refNo: { $regex: `^${escapeRegex(start)}\\d+$`, $options: 'i' } },
    { refNo: 1 },
  ).lean();
  const highest = used.reduce(
    (max, doc) => Math.max(max, Number(doc.refNo.slice(start.length)) || 0),
    series.first - 1,
  );
  return `${start}${highest + 1}`;
}

/** True for a reference of the kind's own series, e.g. "ENGENX-DMA-2026-104". */
const inSeries = (kind, refNo) => {
  const series = REF_SERIES[kind];
  return (
    Boolean(series && refNo) &&
    new RegExp(`^${escapeRegex(series.prefix)}-\\d{4}-\\d+$`, 'i').test(refNo)
  );
};

/**
 * A reference of the series already used by another document of the kind: 409 with the next
 * free one. References typed in another form are the person's own choice and not checked.
 */
async function assertRefFree(kind, refNo, exceptId = null) {
  if (!inSeries(kind, refNo)) return;
  const taken = await GeneratedDocument.exists({
    kind,
    refNo: { $regex: `^${escapeRegex(refNo)}$`, $options: 'i' },
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  });
  if (!taken) return;
  const next = await nextRefNo(kind);
  throw createAppError(
    'REF_TAKEN',
    409,
    `${refNo} is already used by another ${GENERATED_KINDS[kind].label.toLowerCase()}.` +
      (next ? ` The next free reference is ${next}.` : ' Change the reference.'),
    { nextRefNo: next },
  );
}

export async function listGenerated(actor, kind, query) {
  const filter = buildFilter({
    scope: scopeFilter(actor, featureOf(kind), OWNER),
    equals: { kind },
    search: { text: query.search, fields: ['title', 'refNo', 'clientName'] },
  });
  const { rows, pagination } = await runListQuery(GeneratedDocument, {
    filter,
    sort: buildSort(query.sort, SORTS, '-updatedAt'),
    page: query.page,
    pageSize: query.pageSize,
    select: '-data',
  });
  return { items: rows.map(toSummary), pagination };
}

export async function getGenerated(actor, kind, id) {
  return toView(await loadForAction(actor, kind, id, 'view'));
}

export async function createGenerated(actor, kind, input, context = {}) {
  await assertRefFree(kind, input.refNo);
  const doc = await GeneratedDocument.create({
    ...input,
    kind,
    ownerId: actor._id,
    createdBy: actor._id,
    updatedBy: actor._id,
  });
  await writeAudit({
    actor,
    action: `${kind}.generated`,
    entityType,
    entityId: doc._id,
    newValue: { title: doc.title, refNo: doc.refNo, clientName: doc.clientName },
    requestId: context.requestId,
  });
  return toView(doc.toObject());
}

export async function updateGenerated(actor, kind, id, input, context = {}) {
  const before = await loadForAction(actor, kind, id, 'edit');
  const { updatedAt, ...changes } = input;
  if (
    changes.refNo !== undefined &&
    changes.refNo.toLowerCase() !== (before.refNo ?? '').toLowerCase()
  )
    await assertRefFree(kind, changes.refNo, before._id);
  const guard = updatedAt ? { updatedAt: new Date(updatedAt) } : {};
  const after = await GeneratedDocument.findOneAndUpdate(
    { _id: id, kind, ...guard },
    { $set: { ...changes, updatedBy: actor._id } },
    { returnDocument: 'after' },
  ).lean();
  if (!after) {
    throw conflict(
      'Someone saved this document after you opened it. Open it again to see their changes.',
    );
  }
  const shown = ['title', 'refNo', 'clientName'].filter((key) => key in changes);
  await writeAudit({
    actor,
    action: `${kind}.updated`,
    entityType,
    entityId: id,
    oldValue: Object.fromEntries(shown.map((key) => [key, before[key]])),
    newValue: {
      ...Object.fromEntries(shown.map((key) => [key, changes[key]])),
      ...(changes.data ? { content: 'changed' } : {}),
    },
    requestId: context.requestId,
  });
  return toView(after);
}

export async function deleteGenerated(actor, kind, id, context = {}) {
  const doc = await loadForAction(actor, kind, id, 'delete');
  await GeneratedDocument.deleteOne({ _id: doc._id });
  await writeAudit({
    actor,
    action: `${kind}.deleted`,
    entityType,
    entityId: id,
    oldValue: { title: doc.title, refNo: doc.refNo, clientName: doc.clientName },
    requestId: context.requestId,
  });
  return { id: String(doc._id) };
}

/** Kinds the person may open at all (for the seal picture). */
export const mayUseGenerator = (actor) =>
  Object.values(GENERATED_KINDS).some((kind) => can(actor, 'view', { feature: kind.feature }));
