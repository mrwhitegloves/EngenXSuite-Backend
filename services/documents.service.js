import { randomBytes } from 'node:crypto';
import { isStorageConfigured, toReadableUrl, uploadObject } from '../infra/storage.js';
import { writeAudit } from '../lib/audit.js';
import { badRequest, createAppError, notFound } from '../lib/errors.js';
import { Document } from '../models/document.model.js';
import { User } from '../models/user.model.js';
import { loadAccountForAction } from './accounts.service.js';
import { loadLeadForAction } from './opportunities.service.js';

// The documents of a company: files kept in the CRM, to look at and to send with a mail.
//
// A document belongs to a company and is reached through it: who may see the company (and has
// the "documents" permission) sees its documents. One that is put on a lead is shown on the
// company too. The file is in the private bucket (`documents/<accountId>/…`); every answer
// carries a signed link that opens for an hour.
// Phase 08 adds folders, versions, tags and the approval for the AI knowledge base.

const MB = 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 25 * MB;

async function toViews(documents) {
  const users = await User.find({ _id: { $in: documents.map((item) => item.uploadedBy) } })
    .select('name')
    .lean();
  const names = new Map(users.map((user) => [String(user._id), user.name]));
  return Promise.all(
    documents.map(async (document) => ({
      id: String(document._id),
      name: document.name,
      filename: document.filename,
      mimeType: document.mimeType ?? '',
      size: document.size,
      // Our own address of the file: used only to attach it to a mail.
      url: document.url,
      link: await toReadableUrl(document.url),
      opportunityId: document.opportunityId ? String(document.opportunityId) : null,
      uploadedBy: names.get(String(document.uploadedBy)) ?? null,
      createdAt: document.createdAt,
    })),
  );
}

/** The documents of one company, newest first. */
export async function listAccountDocuments(actor, accountId) {
  const account = await loadAccountForAction(actor, accountId, 'view');
  const documents = await Document.find({ accountId: account._id, deletedAt: null })
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();
  return toViews(documents);
}

/**
 * Keep a file for a company (and, when given, for one of its leads).
 * @param {{ accountId: string, opportunityId?: string, name?: string }} target  Validated
 * @param {{ originalname: string, mimetype: string, buffer: Buffer, size: number }} file
 */
export async function uploadDocument(actor, target, file, context = {}) {
  const account = await loadAccountForAction(actor, target.accountId, 'view');
  let opportunityId;
  if (target.opportunityId) {
    const lead = await loadLeadForAction(actor, target.opportunityId, 'view');
    if (String(lead.accountId) !== String(account._id)) {
      throw badRequest('Choose a lead of this company', [{ field: 'opportunityId' }]);
    }
    opportunityId = lead._id;
  }
  if (!isStorageConfigured()) {
    throw createAppError('STORAGE_NOT_CONFIGURED', 503, 'File storage is not set up yet.');
  }
  const filename = String(file.originalname).slice(0, 200);
  const safe = filename.replace(/[^\w.\- ]+/g, '_').slice(-120);
  const url = await uploadObject({
    key: `documents/${account._id}/${randomBytes(6).toString('hex')}-${safe}`,
    body: file.buffer,
    contentType: file.mimetype || 'application/octet-stream',
  });
  const document = await Document.create({
    name: target.name || filename,
    filename,
    mimeType: file.mimetype || 'application/octet-stream',
    size: file.size,
    url,
    accountId: account._id,
    opportunityId,
    uploadedBy: actor._id,
  });
  await writeAudit({
    actor,
    action: 'document.uploaded',
    entityType: 'documents',
    entityId: document._id,
    newValue: { name: document.name, accountId: String(account._id), size: document.size },
    requestId: context.requestId,
  });
  return (await toViews([document.toObject()]))[0];
}

/** Take a document out of the company's list. (The file itself stays in storage.) */
export async function deleteDocument(actor, documentId, context = {}) {
  const document = await Document.findOne({ _id: documentId, deletedAt: null }).lean();
  if (!document) throw notFound('Document not found');
  // Not one of the actor's companies: "not found".
  await loadAccountForAction(actor, document.accountId, 'view').catch(() => {
    throw notFound('Document not found');
  });
  await Document.updateOne({ _id: document._id }, { $set: { deletedAt: new Date() } });
  await writeAudit({
    actor,
    action: 'document.deleted',
    entityType: 'documents',
    entityId: document._id,
    oldValue: { name: document.name },
    requestId: context.requestId,
  });
  return { deleted: true };
}

/**
 * A document by its file address, when the actor may see its company; otherwise null.
 * For a mail that wants to carry it.
 */
export async function findSendableDocument(actor, url) {
  const document = await Document.findOne({ url, deletedAt: null }).lean();
  if (!document) return null;
  try {
    await loadAccountForAction(actor, document.accountId, 'view');
    return document;
  } catch {
    return null;
  }
}
