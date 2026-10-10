import mongoose from 'mongoose';
import { IMPORT_FIELDS, MAX_IMPORT_BYTES, MAX_IMPORT_ROWS } from '../constants/importFields.js';
import { JOB_NAMES } from '../constants/jobNames.js';
import { SOCKET_EVENTS } from '../constants/socketEvents.js';
import { logger } from '../infra/logger.js';
import { enqueue } from '../infra/queues.js';
import { emitToAll, emitToUser } from '../infra/realtime.js';
import {
  isStorageConfigured,
  keyFromUrl,
  readObject,
  toReadableUrl,
  uploadObject,
} from '../infra/storage.js';
import { writeAudit } from '../lib/audit.js';
import { can } from '../lib/can.js';
import { decodeCsv, parseCsv, toCsv } from '../lib/csv.js';
import { badRequest, conflict, createAppError, notFound } from '../lib/errors.js';
import { toNameKey } from '../lib/nameKey.js';
import { runListQuery } from '../lib/queryBuilder.js';
import { scopeFilter } from '../lib/scopeFilter.js';
import { Account } from '../models/account.model.js';
import { Contact } from '../models/contact.model.js';
import { DUPLICATE_MODES, Import, ImportMappingTemplate } from '../models/import.model.js';
import { User } from '../models/user.model.js';
import { createAccount, deleteAccount, updateAccount } from './accounts.service.js';
import { loadRequestUser } from './auth.service.js';
import { createContacts, deleteContact, updateContact } from './contacts.service.js';
import { readRow, suggestMapping, toColumns, uniqueHeaders } from './importRows.service.js';

// CSV import (requirements REQ-IMP-001 … 007). The steps a person goes through:
//
//   1. upload    the file is stored in the private bucket; its headings and first rows are read
//   2. map       each column is given a field (a first guess is made from the headings)
//   3. preview   every row is checked; nothing is saved yet
//   4. run       a background job saves the rows one by one and counts what became of each
//   5. result    counts, a file with the failed rows and why, and "undo"
//
// A row is one company and, optionally, one person at it. Rows are saved through the same
// service functions as the forms (createAccount, createContacts, …), so the same rules apply:
// codes, default status, phone format, audit entries.
//
// Every record an import creates carries its `importId`. That is what "undo" removes.

const FEATURE = 'imports';
const OPEN_STATUSES = ['uploaded', 'mapped'];
// A worker that has not been heard from for this long is taken to be dead; another may go on.
// (A worker notes the time after every row.)
export const STALE_AFTER_MS = 60 * 1000;
const PROGRESS_EVERY_ROWS = 25;
const NOT_DELETED = { deletedAt: null };

const scopeOf = (actor) =>
  scopeFilter(actor, FEATURE, { ownerField: 'createdBy', assignedField: 'createdBy' });

function toListView(item, names) {
  return {
    id: String(item._id),
    targetType: item.targetType,
    fileName: item.fileName,
    fileSize: item.fileSize,
    rowCount: item.rowCount,
    duplicateMode: item.duplicateMode,
    status: item.status,
    processedRows: item.processedRows,
    counts: item.counts,
    failureReason: item.failureReason ?? null,
    undo: item.undo?.accountsRemoved === undefined ? null : item.undo,
    hasErrorFile: Boolean(item.errorFileUrl),
    createdBy: { id: String(item.createdBy), name: names.get(String(item.createdBy)) ?? null },
    createdAt: item.createdAt,
    startedAt: item.startedAt ?? null,
    finishedAt: item.finishedAt ?? null,
    undoneAt: item.undoneAt ?? null,
  };
}

async function toDetailView(item) {
  const names = await userNames([item.createdBy]);
  return {
    ...toListView(item, names),
    headers: item.headers,
    sampleRows: item.sampleRows,
    mapping: item.mapping.map(({ column, field }) => ({ column, field })),
    // The first failed rows; the error file has all of them.
    rowErrors: (item.rowErrors ?? []).slice(0, 50),
    // A link that works for an hour (the bucket is private).
    errorFileLink: await toReadableUrl(item.errorFileUrl),
  };
}

async function userNames(ids) {
  const users = await User.find({ _id: { $in: ids } })
    .select('name')
    .lean();
  return new Map(users.map((user) => [String(user._id), user.name]));
}

/** One import the actor may see; anything else answers "not found". */
async function loadImport(actor, importId) {
  const item = await Import.findOne({ $and: [{ _id: importId }, scopeOf(actor)] })
    .select('+rowErrors')
    .lean();
  if (!item) throw notFound('Import not found');
  return item;
}

function toTemplateView(template) {
  return {
    id: String(template._id),
    name: template.name,
    targetType: template.targetType,
    mapping: template.mapping.map(({ column, field }) => ({ column, field })),
  };
}

/** What the import screen needs before a file is chosen. */
export async function getImportOptions() {
  const templates = await ImportMappingTemplate.find().sort({ nameKey: 1 }).lean();
  return {
    fields: IMPORT_FIELDS.map(({ field, label, group, required }) => ({
      field,
      label,
      group,
      required: Boolean(required),
    })),
    duplicateModes: DUPLICATE_MODES,
    limits: { maxBytes: MAX_IMPORT_BYTES, maxRows: MAX_IMPORT_ROWS },
    storage: isStorageConfigured() ? 'configured' : 'not_configured',
    templates: templates.map(toTemplateView),
  };
}

export async function listImports(actor, { page, pageSize }) {
  const { rows, pagination } = await runListQuery(Import, {
    filter: scopeOf(actor),
    sort: { createdAt: -1, _id: -1 },
    page,
    pageSize,
    select: '-headers -sampleRows -mapping',
  });
  const names = await userNames(rows.map((row) => row.createdBy));
  return { items: rows.map((row) => toListView(row, names)), pagination };
}

export async function getImport(actor, importId) {
  return toDetailView(await loadImport(actor, importId));
}

/**
 * Step 1: store the uploaded file and read its headings.
 * @param {object} actor
 * @param {{ originalname: string, buffer: Buffer, size: number }} file  From the upload middleware
 * @param {{ targetType: string }} data  Validated
 */
export async function uploadImport(actor, file, { targetType }, context = {}) {
  if (!isStorageConfigured()) {
    throw createAppError(
      'STORAGE_NOT_CONFIGURED',
      503,
      'File storage is not set up yet, so files cannot be imported.',
    );
  }
  // An Excel workbook (.xlsx) is a zip file: it is not text, whatever its name says.
  if (!/\.csv$/i.test(file.originalname) || file.buffer.includes(0)) {
    throw badRequest(
      'This is not a CSV file. In Excel or Google Sheets, save the sheet as “CSV UTF-8” first.',
    );
  }
  const rows = parseCsv(decodeCsv(file.buffer));
  if (rows.length < 2) {
    throw badRequest('The file needs a heading row and at least one row below it.');
  }
  const rowCount = rows.length - 1;
  if (rowCount > MAX_IMPORT_ROWS) {
    throw badRequest(
      `The file has ${rowCount} rows. The limit is ${MAX_IMPORT_ROWS}: split it into smaller files.`,
    );
  }

  const id = new mongoose.Types.ObjectId();
  const headers = uniqueHeaders(rows[0]);
  const fileUrl = await uploadObject({
    key: `imports/${id}/source.csv`,
    body: file.buffer,
    contentType: 'text/csv',
  });
  const item = await Import.create({
    _id: id,
    targetType,
    fileName: file.originalname.slice(0, 200),
    fileSize: file.size,
    fileUrl,
    headers,
    sampleRows: rows.slice(1, 6).map((row) => headers.map((_, index) => row[index] ?? '')),
    rowCount,
    mapping: suggestMapping(headers),
    createdBy: actor._id,
  });
  await writeAudit({
    actor,
    action: 'import.uploaded',
    entityType: 'imports',
    entityId: item._id,
    newValue: { fileName: item.fileName, rows: rowCount },
    requestId: context.requestId,
  });
  return toDetailView(item.toObject());
}

/** The data rows of an import's file (without the heading row); null when the file is gone. */
async function readFileRows(item) {
  const buffer = await readObject(keyFromUrl(item.fileUrl));
  return buffer ? parseCsv(decodeCsv(buffer)).slice(1) : null;
}

/** The company in the CRM that a row is about: the same name, phone or email. */
function findExistingAccount(account) {
  const matches = [{ nameKey: toNameKey(account.name) }];
  if (account.phone_number) matches.push({ phone_number: account.phone_number });
  if (account.email) matches.push({ email: account.email });
  return Account.findOne({ ...NOT_DELETED, $or: matches }).lean();
}

/** A filter value that matches exactly this text, in any letter case. */
function sameText(text) {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}$`, 'i');
}

/** The person at a company that a row is about: the same phone or email, or the same name. */
function findExistingContact(accountId, contact) {
  const phones = [contact.phone_number, contact.alt_phone_number].filter(Boolean);
  const matches = [{ name: sameText(contact.name) }];
  if (phones.length) {
    matches.push({ phone_number: { $in: phones } }, { alt_phone_number: { $in: phones } });
  }
  if (contact.email) matches.push({ email: contact.email });
  return Contact.findOne({ accountId, ...NOT_DELETED, $or: matches }).lean();
}

/**
 * Step 3: check every row with the chosen mapping. Nothing is saved except the mapping itself.
 * @param {{ mapping: { column: string, field: string }[], duplicateMode: string }} data  Validated
 */
export async function previewImport(actor, importId, { mapping, duplicateMode }) {
  const item = await loadImport(actor, importId);
  if (!OPEN_STATUSES.includes(item.status)) throw conflict('This import has already been started.');
  const columns = toColumns(mapping, item.headers);
  const rows = await readFileRows(item);
  if (!rows) throw conflict('The uploaded file is no longer in storage. Upload it again.');

  const counts = {
    total: rows.length,
    valid: 0,
    invalid: 0,
    newCompanies: 0,
    existing: 0,
    people: 0,
  };
  const problems = [];
  // Companies an earlier row of this same file will create.
  const earlierInFile = new Set();
  for (const [index, cells] of rows.entries()) {
    const { account, contact, errors } = readRow(cells, columns);
    if (errors.length > 0) {
      counts.invalid += 1;
      if (problems.length < 50) problems.push({ row: index + 1, message: errors.join(' · ') });
      continue;
    }
    counts.valid += 1;
    if (contact) counts.people += 1;
    const nameKey = toNameKey(account.name);
    if (earlierInFile.has(nameKey) || (await findExistingAccount(account))) counts.existing += 1;
    else counts.newCompanies += 1;
    earlierInFile.add(nameKey);
  }

  await Import.updateOne(
    { _id: item._id, status: { $in: OPEN_STATUSES } },
    { $set: { mapping, duplicateMode, status: 'mapped' } },
  );
  return { counts, problems };
}

/** Save a mapping under a name, for the next file of the same shape. The name is reused. */
export async function saveTemplate(actor, { name, targetType, mapping }) {
  const template = await ImportMappingTemplate.findOneAndUpdate(
    { targetType, nameKey: name.trim().toLowerCase() },
    { $set: { name: name.trim(), mapping }, $setOnInsert: { createdBy: actor._id } },
    { upsert: true, new: true },
  ).lean();
  return toTemplateView(template);
}

export async function deleteTemplate(templateId) {
  const result = await ImportMappingTemplate.deleteOne({ _id: templateId });
  if (result.deletedCount === 0) throw notFound('Template not found');
}

/**
 * Hand work to the background worker. Without a queue (Redis is down or not set up) the work
 * still has to happen, so it then runs in this process, after the request has been answered.
 */
async function dispatch(jobName, importId, run) {
  try {
    // The fixed job id makes a second click a no-op.
    await enqueue(
      'integrations',
      jobName,
      { importId: String(importId) },
      { jobId: `${jobName}-${importId}`.replaceAll('.', '-') },
    );
  } catch (error) {
    logger.warn({ err: error, importId: String(importId) }, 'No queue: running the import here');
    setImmediate(() => {
      run(importId).catch((runError) =>
        logger.error({ err: runError, importId: String(importId) }, 'Import work failed'),
      );
    });
  }
}

/**
 * Step 4: start the import. The rows are saved by a background job.
 * @param {{ mapping: object[], duplicateMode: string, saveTemplateAs?: string }} data  Validated
 */
export async function startImport(actor, importId, data, context = {}) {
  const item = await loadImport(actor, importId);
  toColumns(data.mapping, item.headers);
  if (data.saveTemplateAs) {
    await saveTemplate(actor, {
      name: data.saveTemplateAs,
      targetType: item.targetType,
      mapping: data.mapping,
    });
  }
  // Only one request can move it from "open" to "queued": a double click starts one run.
  const started = await Import.findOneAndUpdate(
    { _id: item._id, status: { $in: OPEN_STATUSES } },
    { $set: { mapping: data.mapping, duplicateMode: data.duplicateMode, status: 'queued' } },
    { new: true },
  ).lean();
  if (!started) throw conflict('This import has already been started.');

  await writeAudit({
    actor,
    action: 'import.started',
    entityType: 'imports',
    entityId: item._id,
    newValue: { fileName: item.fileName, rows: item.rowCount, duplicateMode: data.duplicateMode },
    requestId: context.requestId,
  });
  await dispatch(JOB_NAMES.importRun, item._id, runImport);
  return toDetailView(started);
}

/** Take an import for work, so that two workers never run the same one. */
function claim(importId, status) {
  const staleBefore = new Date(Date.now() - STALE_AFTER_MS);
  return Import.findOneAndUpdate(
    {
      _id: importId,
      $or: [
        { status, heartbeatAt: null },
        // A worker died half-way (server restart): go on where it stopped.
        { status: status === 'queued' ? 'running' : status, heartbeatAt: { $lt: staleBefore } },
      ],
    },
    { $set: { heartbeatAt: new Date(), ...(status === 'queued' ? { status: 'running' } : {}) } },
    { new: true },
  ).lean();
}

/** True while an import is marked as in work (by a live worker, or by one that just died). */
async function isBeingWorkedOn(importId) {
  return Boolean(await Import.exists({ _id: importId, status: { $in: ['running', 'undoing'] } }));
}

const failureMessage = (error) =>
  [error.message, ...(error.details ?? []).map((detail) => detail.message)]
    .filter((text, index, list) => text && list.indexOf(text) === index)
    .join(' · ');

/** The values of a row that are filled in, as changes for an existing record. */
const filledOnly = (data, leaveOut = []) =>
  Object.fromEntries(
    Object.entries(data).filter(
      ([key, value]) => value !== null && value !== undefined && !leaveOut.includes(key),
    ),
  );

/**
 * Save one row. Returns what became of it: created (a new company), updated (an existing
 * company was changed or got a new person), or skipped (nothing was changed).
 */
async function applyRow(actor, item, rowNumber, cells, columns) {
  const { account, contact, errors } = readRow(cells, columns);
  if (errors.length > 0) throw badRequest(errors.join(' · '));
  const context = { importId: item._id, importRow: rowNumber, quiet: true };
  const existing = item.duplicateMode === 'create' ? null : await findExistingAccount(account);

  let outcome = 'skipped';
  let accountId;
  if (!existing) {
    const created = await createAccount(actor, { ...account, confirmDuplicate: true }, context);
    accountId = created.id;
    outcome = 'created';
  } else {
    accountId = existing._id;
    const mayEdit = can(actor, 'edit', { feature: 'accounts', record: existing });
    if (item.duplicateMode === 'update' || contact) {
      if (!mayEdit) {
        throw conflict(`"${existing.name}" is already in the CRM and belongs to someone else.`);
      }
    }
    if (item.duplicateMode === 'update') {
      // The existing name stays: the match may have been by phone or email.
      const changes = filledOnly(account, ['name']);
      if (Object.keys(changes).length > 0) {
        await updateAccount(actor, existing._id, { ...changes, confirmDuplicate: true }, context);
        const after = await Account.findById(existing._id).select('updatedAt').lean();
        if (+after.updatedAt !== +existing.updatedAt) outcome = 'updated';
      }
    }
  }

  if (contact) {
    const person = existing ? await findExistingContact(accountId, contact) : null;
    try {
      if (!person) {
        await createContacts(actor, accountId, [contact], context);
        if (outcome === 'skipped') outcome = 'updated';
      } else if (item.duplicateMode === 'update') {
        const before = person.updatedAt;
        await updateContact(actor, person._id, filledOnly(contact, ['name']), context);
        const after = await Contact.findById(person._id).select('updatedAt').lean();
        if (outcome === 'skipped' && +after.updatedAt !== +before) outcome = 'updated';
      }
    } catch (error) {
      // The company part of the row is saved already; say so, so nobody enters it twice.
      const prefix =
        outcome === 'created'
          ? 'The company was added, but the person was not'
          : 'The person was not saved';
      throw badRequest(`${prefix}: ${failureMessage(error)}`);
    }
  }
  return outcome;
}

async function finish(item, set, reason) {
  await Import.updateOne(
    { _id: item._id },
    { $set: { ...set, finishedAt: new Date(), heartbeatAt: null } },
  );
  if (reason) logger.warn({ importId: String(item._id), reason }, 'Import stopped');
  emitToUser(item.createdBy, SOCKET_EVENTS.importsChanged);
}

/**
 * The background job: save the rows of one import. Safe to run twice: only one run can claim an
 * import, a finished import is left alone, and a run that was cut off goes on at the next row.
 * @param {unknown} importId
 */
export async function runImport(importId) {
  const item = await claim(importId, 'queued');
  if (!item) return { skipped: true, busy: await isBeingWorkedOn(importId) };
  if (!item.startedAt)
    await Import.updateOne({ _id: item._id }, { $set: { startedAt: new Date() } });

  const stop = (reason) => finish(item, { status: 'failed', failureReason: reason }, reason);
  try {
    const actor = await loadRequestUser(item.createdBy);
    if (!actor) return await stop('The person who started this import is no longer active.');
    const rows = await readFileRows(item);
    if (!rows) return await stop('The uploaded file is no longer in storage.');
    const columns = toColumns(item.mapping, item.headers);

    let done = item.processedRows;
    // Cut off after a row's company was saved but before that was noted: do not save it again.
    if (done < rows.length && (await Account.exists({ importId: item._id, importRow: done + 1 }))) {
      await Import.updateOne(
        { _id: item._id },
        { $inc: { processedRows: 1, 'counts.created': 1 } },
      );
      done += 1;
    }

    for (; done < rows.length; done += 1) {
      const rowNumber = done + 1;
      let outcome;
      let message;
      try {
        outcome = await applyRow(actor, item, rowNumber, rows[done], columns);
      } catch (error) {
        if (!error?.isAppError) logger.error({ err: error, rowNumber }, 'Import row failed');
        outcome = 'failed';
        message = error?.isAppError ? failureMessage(error) : 'This row could not be saved.';
      }
      await Import.updateOne(
        { _id: item._id },
        {
          $inc: { processedRows: 1, [`counts.${outcome}`]: 1 },
          $set: { heartbeatAt: new Date() },
          ...(message ? { $push: { rowErrors: { row: rowNumber, message } } } : {}),
        },
      );
      if (rowNumber % PROGRESS_EVERY_ROWS === 0) {
        emitToUser(item.createdBy, SOCKET_EVENTS.importsChanged);
      }
    }

    // The failed rows as a file: the original columns, plus the row number and the reason.
    const result = await Import.findById(item._id).select('+rowErrors').lean();
    let errorFileUrl;
    if (result.rowErrors.length > 0) {
      const csv = toCsv(
        [
          { header: 'Row', value: (entry) => entry.row + 1 }, // as numbered in the spreadsheet
          { header: 'Problem', value: (entry) => entry.message },
          ...item.headers.map((header, index) => ({
            header,
            value: (entry) => rows[entry.row - 1]?.[index] ?? '',
          })),
        ],
        result.rowErrors,
      );
      errorFileUrl = await uploadObject({
        key: `imports/${item._id}/errors.csv`,
        body: Buffer.from(csv, 'utf8'),
        contentType: 'text/csv',
      });
    }

    await writeAudit({
      actor,
      action: 'import.completed',
      entityType: 'imports',
      entityId: item._id,
      newValue: { fileName: item.fileName, rows: rows.length, ...result.counts },
    });
    await finish(item, { status: 'completed', ...(errorFileUrl ? { errorFileUrl } : {}) });
    // One announcement for the whole batch, not one per row.
    emitToAll(SOCKET_EVENTS.accountsChanged);
    emitToAll(SOCKET_EVENTS.contactsChanged);
    return { rows: rows.length, ...result.counts };
  } catch (error) {
    logger.error({ err: error, importId: String(item._id) }, 'Import failed');
    await stop('The import stopped because of a system problem. Rows saved so far are kept.');
    return { failed: true };
  }
}

/** Step 5, on request: take back what an import created. Done by a background job. */
export async function undoImport(actor, importId, context = {}) {
  const item = await loadImport(actor, importId);
  const started = await Import.findOneAndUpdate(
    { _id: item._id, status: { $in: ['completed', 'failed'] } },
    { $set: { status: 'undoing', undoneBy: actor._id, heartbeatAt: null } },
    { new: true },
  ).lean();
  if (!started) throw conflict('Only a finished import can be undone, and only once.');

  await writeAudit({
    actor,
    action: 'import.undo_started',
    entityType: 'imports',
    entityId: item._id,
    newValue: { fileName: item.fileName },
    requestId: context.requestId,
  });
  await dispatch(JOB_NAMES.importUndo, item._id, runImportUndo);
  return toDetailView(started);
}

/**
 * The background job: remove exactly the records one import created. Records the import only
 * changed are not turned back. Removing follows the usual rules (deleteAccount, deleteContact),
 * with the rights of the person who asked for the undo: what may not be deleted is kept and
 * counted. Safe to run twice: a record that is gone already is not found again.
 */
export async function runImportUndo(importId) {
  const item = await claim(importId, 'undoing');
  if (!item) return { skipped: true, busy: await isBeingWorkedOn(importId) };
  const actor = await loadRequestUser(item.undoneBy);
  const counts = { accountsRemoved: 0, contactsRemoved: 0, kept: 0 };
  const quiet = { quiet: true };

  const remove = async (records, removeOne, counter) => {
    for (const record of records) {
      try {
        if (!actor) throw new Error('The person who asked for the undo is no longer active');
        await removeOne(actor, record._id, quiet);
        counts[counter] += 1;
      } catch (error) {
        counts.kept += 1;
        logger.warn({ err: error, recordId: String(record._id) }, 'Undo kept a record');
      }
      await Import.updateOne({ _id: item._id }, { $set: { heartbeatAt: new Date() } });
    }
  };
  const mine = { importId: item._id, ...NOT_DELETED };
  await remove(await Account.find(mine).select('_id').lean(), deleteAccount, 'accountsRemoved');
  // People the import added to companies that were there before (the others went with their company).
  await remove(await Contact.find(mine).select('_id').lean(), deleteContact, 'contactsRemoved');

  await Import.updateOne(
    { _id: item._id },
    { $set: { status: 'undone', undo: counts, undoneAt: new Date(), heartbeatAt: null } },
  );
  await writeAudit({
    actor,
    action: 'import.undone',
    entityType: 'imports',
    entityId: item._id,
    newValue: { fileName: item.fileName, ...counts },
  });
  emitToAll(SOCKET_EVENTS.accountsChanged);
  emitToAll(SOCKET_EVENTS.contactsChanged);
  emitToAll(SOCKET_EVENTS.plantsChanged);
  emitToUser(item.createdBy, SOCKET_EVENTS.importsChanged);
  if (String(item.undoneBy) !== String(item.createdBy)) {
    emitToUser(item.undoneBy, SOCKET_EVENTS.importsChanged);
  }
  return counts;
}

/**
 * Run import work that may have been cut off. When the import still looks "in work" (its last
 * worker stopped only a moment ago, for example at a server restart), wait until that worker
 * would count as dead, then try once more.
 * @param {(importId: unknown) => Promise<{ busy?: boolean }>} run  runImport or runImportUndo
 */
export async function runWhenFree(run, importId, waitMs = STALE_AFTER_MS + 5000) {
  const result = await run(importId);
  if (!result.busy) return result;
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  return run(importId);
}

/**
 * At server start: go on with imports that were waiting or half done when the server stopped.
 * (With a queue, its own retry does the same; without one, nothing else would.)
 */
export async function resumeInterruptedImports() {
  const waiting = await Import.find({ status: { $in: ['queued', 'running', 'undoing'] } })
    .select('status')
    .lean();
  for (const item of waiting) {
    const run = item.status === 'undoing' ? runImportUndo : runImport;
    runWhenFree(run, item._id).catch((error) =>
      logger.error({ err: error, importId: String(item._id) }, 'Import could not be resumed'),
    );
  }
  return waiting.length;
}
