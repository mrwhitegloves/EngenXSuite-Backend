import { randomBytes } from 'node:crypto';
import { getAttachment, getMessage } from '../integrations/google/gmail.js';
import { logger } from '../infra/logger.js';
import { isStorageConfigured, toReadableUrl, uploadObject } from '../infra/storage.js';
import { badRequest, createAppError } from '../lib/errors.js';
import { Email } from '../models/email.model.js';

// The files of customer mail. An attachment of a kept mail is copied from Gmail into our own
// private storage; the mail keeps only the file's address there. The browser never gets that
// address: every answer carries a signed link that works for an hour (toReadableUrl).
//   emails/<emailId>/<n>-<name>            a file that came or went with a mail
//   email-uploads/<userId>/<id>/<name>     a file a person picked to send with their next mail

const MB = 1024 * 1024;
// A larger attachment is not copied: its name still shows, and it opens in Gmail.
export const MAX_KEPT_ATTACHMENT_BYTES = 20 * MB;
export const MAX_UPLOAD_BYTES = 15 * MB;
// Gmail takes 25 MB for a whole message, and encoding makes files about a third larger.
export const MAX_SEND_BYTES = 17 * MB;

/** A file name that is safe as part of a storage key. */
const safeName = (name) =>
  String(name || 'file')
    .replace(/[^\w.\- ]+/g, '_')
    .slice(-120);

/** The key prefix under which a person's own picked files live. */
export const uploadPrefixOf = (userId) => `email-uploads/${userId}/`;

/**
 * Copy the attachments of one Gmail message into storage.
 * @param {{ filename: string, mimeType: string, size: number, attachmentId?: string | null }[]} attachments
 * @returns {Promise<{ filename: string, mimeType: string, size: number, url?: string }[]>}
 *          What the mail keeps: the same list, each with the address of its copy (when copied)
 */
export async function storeMessageAttachments(token, emailId, gmailMessageId, attachments) {
  const kept = [];
  for (const [index, file] of attachments.entries()) {
    const entry = { filename: file.filename, mimeType: file.mimeType, size: file.size };
    const canCopy =
      isStorageConfigured() && file.attachmentId && file.size <= MAX_KEPT_ATTACHMENT_BYTES;
    if (canCopy) {
      try {
        const body = await getAttachment(token, gmailMessageId, file.attachmentId);
        entry.url = await uploadObject({
          key: `emails/${emailId}/${index + 1}-${safeName(file.filename)}`,
          body,
          contentType: file.mimeType || 'application/octet-stream',
        });
        entry.size = body.length;
      } catch (error) {
        // The mail is kept either way; the file then only shows by name.
        logger.warn({ err: error, emailId: String(emailId) }, 'An attachment was not copied');
      }
    }
    kept.push(entry);
  }
  return kept;
}

/**
 * Keep a file a person picked from their device, to send with their next mail.
 * @param {{ originalname: string, mimetype: string, buffer: Buffer, size: number }} file
 * @returns {Promise<{ url: string, filename: string, mimeType: string, size: number, link: string }>}
 */
export async function keepUploadedFile(actor, file) {
  if (!isStorageConfigured()) {
    throw createAppError('STORAGE_NOT_CONFIGURED', 503, 'File storage is not set up yet.');
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw badRequest(`The file is too large. The limit is ${MAX_UPLOAD_BYTES / MB} MB.`);
  }
  const filename = String(file.originalname).slice(0, 200);
  const mimeType = file.mimetype || 'application/octet-stream';
  const url = await uploadObject({
    key: `${uploadPrefixOf(actor._id)}${randomBytes(8).toString('hex')}/${safeName(filename)}`,
    body: file.buffer,
    contentType: mimeType,
  });
  return { url, filename, mimeType, size: file.size, link: await toReadableUrl(url) };
}

/** Attachments as a screen gets them: the name, and a link that opens for an hour. */
export const attachmentViews = (attachments = []) =>
  Promise.all(
    attachments.map(async (file) => ({
      filename: file.filename,
      mimeType: file.mimeType ?? '',
      size: file.size ?? 0,
      // Our own address of the file: used only to attach it to another mail.
      url: file.url ?? null,
      // Empty when the file was too large to copy: it then opens in Gmail only.
      link: file.url ? await toReadableUrl(file.url) : null,
    })),
  );

/**
 * Mail that was kept before files were copied has only the names of its files. A few of those
 * mails are looked at again with every reading of the mailbox, and their files are copied.
 * Each mail is tried once.
 * @returns {Promise<number>} How many mails got their files
 */
export async function backfillAttachments(token, userId, limit = 5) {
  if (!isStorageConfigured()) return 0;
  const emails = await Email.find({
    userId,
    'attachments.0': { $exists: true },
    'attachments.url': { $exists: false },
    filesCheckedAt: null,
  })
    .sort({ sentAt: -1 })
    .limit(limit)
    .lean();
  let filled = 0;
  for (const email of emails) {
    const set = { filesCheckedAt: new Date() };
    try {
      const message = await getMessage(token, email.gmailMessageId);
      set.attachments = await storeMessageAttachments(
        token,
        email._id,
        email.gmailMessageId,
        message.attachments,
      );
      if (set.attachments.some((file) => file.url)) filled += 1;
    } catch (error) {
      // Deleted in Gmail meanwhile, or Gmail will not give it: the names stay as they are.
      logger.info({ reason: error?.message, emailId: String(email._id) }, 'No files for a mail');
    }
    await Email.updateOne({ _id: email._id }, { $set: set });
  }
  return filled;
}
