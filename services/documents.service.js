import { randomBytes } from 'node:crypto';
import { isStorageConfigured, toReadableUrl, uploadObject } from '../infra/storage.js';
import { writeAudit } from '../lib/audit.js';
import { can } from '../lib/can.js';
import { badRequest, conflict, createAppError, notFound } from '../lib/errors.js';
import { containsPattern } from '../lib/queryBuilder.js';
import { Document, DocumentFolder } from '../models/document.model.js';
import { User } from '../models/user.model.js';

// Documents: ONE library for the whole CRM (the "Documents" screen). The team keeps its files
// in folders it makes itself: brochures, offers, drawings, pictures, videos. A document is not
// tied to a customer; any of them can be opened, downloaded, or sent with a mail to anyone.
//
// Who may do what is the "documents" permission: view (look, download, send with a mail),
// create (add files and folders), edit (rename, move, delete).
// The file is in the private bucket (`documents/…`); every answer carries a signed link that
// opens for an hour. Versions and the approval for the AI knowledge base join in phase 08.

const MB = 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 25 * MB;
// How deep folders may be nested, and how many rows one folder shows.
const MAX_DEPTH = 6;
const MAX_ROWS = 500;

const sameId = (a, b) => String(a ?? '') === String(b ?? '');
const fieldProblem = (field, message) => badRequest(message, [{ field, message }]);

async function loadFolder(folderId) {
  if (!folderId) return null;
  const folder = await DocumentFolder.findById(folderId).lean();
  if (!folder) throw notFound('Folder not found');
  return folder;
}

/** The folders from the top down to this one: [{ id, name }]. Empty for the top. */
async function pathOf(folder) {
  const path = [];
  let current = folder;
  while (current && path.length < MAX_DEPTH + 2) {
    path.unshift({ id: String(current._id), name: current.name });
    current = current.parentId ? await DocumentFolder.findById(current.parentId).lean() : null;
  }
  return path;
}

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
      folderId: document.folderId ? String(document.folderId) : null,
      // Our own address of the file: used only to attach it to a mail.
      url: document.url,
      link: await toReadableUrl(document.url),
      uploadedBy: names.get(String(document.uploadedBy)) ?? null,
      createdAt: document.createdAt,
    })),
  );
}

const folderView = (folder, counts) => ({
  id: String(folder._id),
  name: folder.name,
  parentId: folder.parentId ? String(folder.parentId) : null,
  documentCount: counts?.get(String(folder._id)) ?? 0,
});

/**
 * What one folder holds (the top when no folder is given): its folders and its documents. With
 * a search text: every document of the library whose name matches, wherever it is.
 * @param {{ folderId?: string, search?: string }} query  Validated
 */
export async function browseDocuments(actor, { folderId, search }) {
  const folder = await loadFolder(folderId);
  const parentId = folder?._id ?? null;
  const [folders, documents] = await Promise.all([
    search ? [] : DocumentFolder.find({ parentId }).sort({ name: 1 }).limit(MAX_ROWS).lean(),
    Document.find(
      search
        ? { deletedAt: null, name: containsPattern(search) }
        : { deletedAt: null, folderId: parentId },
    )
      .sort({ name: 1 })
      .limit(MAX_ROWS)
      .lean(),
  ]);
  const inside = await Document.aggregate([
    { $match: { deletedAt: null, folderId: { $in: folders.map((item) => item._id) } } },
    { $group: { _id: '$folderId', count: { $sum: 1 } } },
  ]);
  const counts = new Map(inside.map((item) => [String(item._id), item.count]));
  return {
    folder: folder ? folderView(folder) : null,
    path: await pathOf(folder),
    folders: folders.map((item) => folderView(item, counts)),
    documents: await toViews(documents),
  };
}

/** Every folder with its full path ("Offers / 2026"), for "move to…". */
export async function listAllFolders() {
  const folders = await DocumentFolder.find().limit(2000).lean();
  const byId = new Map(folders.map((folder) => [String(folder._id), folder]));
  const full = (folder, depth = 0) =>
    folder.parentId && byId.has(String(folder.parentId)) && depth < MAX_DEPTH
      ? `${full(byId.get(String(folder.parentId)), depth + 1)} / ${folder.name}`
      : folder.name;
  return folders
    .map((folder) => ({ id: String(folder._id), path: full(folder) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

async function savedFolder(write) {
  try {
    return await write();
  } catch (error) {
    if (error?.code === 11000) throw conflict('A folder with this name is here already.');
    throw error;
  }
}

/** @param {{ name: string, parentId?: string }} data  Validated */
export async function createFolder(actor, { name, parentId }, context = {}) {
  const parent = await loadFolder(parentId);
  if ((await pathOf(parent)).length >= MAX_DEPTH) {
    throw fieldProblem('parentId', `Folders can be ${MAX_DEPTH} deep at most.`);
  }
  const folder = await savedFolder(() =>
    DocumentFolder.create({ name, parentId: parent?._id ?? null, createdBy: actor._id }),
  );
  await writeAudit({
    actor,
    action: 'document_folder.created',
    entityType: 'document_folders',
    entityId: folder._id,
    newValue: { name },
    requestId: context.requestId,
  });
  return folderView(folder);
}

export async function renameFolder(actor, folderId, { name }, context = {}) {
  const before = await loadFolder(folderId);
  const after = await savedFolder(() =>
    DocumentFolder.findByIdAndUpdate(
      before._id,
      { $set: { name } },
      { returnDocument: 'after' },
    ).lean(),
  );
  await writeAudit({
    actor,
    action: 'document_folder.renamed',
    entityType: 'document_folders',
    entityId: after._id,
    oldValue: { name: before.name },
    newValue: { name },
    requestId: context.requestId,
  });
  return folderView(after);
}

/** Only an empty folder can be deleted: move or delete what is in it first. */
export async function deleteFolder(actor, folderId, context = {}) {
  const folder = await loadFolder(folderId);
  const [hasFolders, hasDocuments] = await Promise.all([
    DocumentFolder.exists({ parentId: folder._id }),
    Document.exists({ folderId: folder._id, deletedAt: null }),
  ]);
  if (hasFolders || hasDocuments) {
    throw conflict('This folder is not empty. Move or delete what is in it first.');
  }
  await DocumentFolder.deleteOne({ _id: folder._id });
  await writeAudit({
    actor,
    action: 'document_folder.deleted',
    entityType: 'document_folders',
    entityId: folder._id,
    oldValue: { name: folder.name },
    requestId: context.requestId,
  });
  return { deleted: true };
}

/**
 * Add a file to the library.
 * @param {{ folderId?: string, name?: string }} target  Validated
 * @param {{ originalname: string, mimetype: string, buffer: Buffer, size: number }} file
 */
export async function uploadDocument(actor, target, file, context = {}) {
  const folder = await loadFolder(target.folderId);
  if (!isStorageConfigured()) {
    throw createAppError('STORAGE_NOT_CONFIGURED', 503, 'File storage is not set up yet.');
  }
  const filename = String(file.originalname).slice(0, 200);
  const safe = filename.replace(/[^\w.\- ]+/g, '_').slice(-120);
  const url = await uploadObject({
    key: `documents/${randomBytes(8).toString('hex')}-${safe}`,
    body: file.buffer,
    contentType: file.mimetype || 'application/octet-stream',
  });
  const document = await Document.create({
    name: target.name || filename,
    filename,
    mimeType: file.mimetype || 'application/octet-stream',
    size: file.size,
    url,
    folderId: folder?._id ?? null,
    uploadedBy: actor._id,
  });
  await writeAudit({
    actor,
    action: 'document.uploaded',
    entityType: 'documents',
    entityId: document._id,
    newValue: { name: document.name, size: document.size, folder: folder?.name ?? null },
    requestId: context.requestId,
  });
  return (await toViews([document.toObject()]))[0];
}

async function loadDocument(documentId) {
  const document = await Document.findOne({ _id: documentId, deletedAt: null }).lean();
  if (!document) throw notFound('Document not found');
  return document;
}

/**
 * Rename a document, or move it to another folder (folderId null: to the top).
 * @param {{ name?: string, folderId?: string | null }} changes  Validated
 */
export async function updateDocument(actor, documentId, changes, context = {}) {
  const before = await loadDocument(documentId);
  const set = {};
  if (changes.name !== undefined) set.name = changes.name;
  if (changes.folderId !== undefined && !sameId(changes.folderId, before.folderId)) {
    set.folderId = (await loadFolder(changes.folderId))?._id ?? null;
  }
  if (Object.keys(set).length === 0) return (await toViews([before]))[0];
  const after = await Document.findByIdAndUpdate(
    before._id,
    { $set: set },
    { returnDocument: 'after' },
  ).lean();
  await writeAudit({
    actor,
    action: 'document.updated',
    entityType: 'documents',
    entityId: after._id,
    oldValue: { name: before.name, folderId: before.folderId ? String(before.folderId) : null },
    newValue: { name: after.name, folderId: after.folderId ? String(after.folderId) : null },
    requestId: context.requestId,
  });
  return (await toViews([after]))[0];
}

/** Take a document out of the library. (The file itself stays in storage.) */
export async function deleteDocument(actor, documentId, context = {}) {
  const document = await loadDocument(documentId);
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
 * A document by its file address, when the actor may look at documents; otherwise null.
 * For a mail that wants to carry it.
 */
export async function findSendableDocument(actor, url) {
  if (!can(actor, 'view', { feature: 'documents' })) return null;
  return Document.findOne({ url, deletedAt: null }).lean();
}
