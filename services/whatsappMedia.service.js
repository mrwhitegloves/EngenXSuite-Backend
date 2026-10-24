import { randomBytes } from 'node:crypto';
import { JOB_NAMES } from '../constants/jobNames.js';
import { downloadWhatsAppMedia } from '../integrations/meta/whatsapp.js';
import { logger } from '../infra/logger.js';
import { enqueue } from '../infra/queues.js';
import { isStorageConfigured, uploadObject } from '../infra/storage.js';
import { badRequest } from '../lib/errors.js';
import { WhatsAppMessage } from '../models/whatsapp.model.js';

// Files of WhatsApp messages (docs/WHATSAPP.md):
//   - what may be sent, as which WhatsApp kind, up to which size (WhatsApp's own limits);
//   - every file is kept in our private S3 bucket under whatsapp/<conversation>/…, so the
//     conversation keeps showing it (answers carry a signed link);
//   - a file a customer sent is fetched from Meta in the background (job whatsapp.media).

const MB = 1024 * 1024;
// The largest file the screen may send (the biggest per-kind limit below).
export const MAX_WHATSAPP_UPLOAD_BYTES = 25 * MB;

const KINDS = {
  image: { types: ['image/jpeg', 'image/png'], maxBytes: 5 * MB, word: 'image' },
  video: { types: ['video/mp4', 'video/3gpp'], maxBytes: 16 * MB, word: 'video' },
  audio: {
    types: ['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg'],
    maxBytes: 16 * MB,
    word: 'audio',
  },
  document: {
    types: [
      'application/pdf',
      'text/plain',
      'text/csv',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/zip',
      'application/x-zip-compressed',
      // Pictures WhatsApp does not take as a picture still go, as a document.
      'image/gif',
      'image/webp',
      'image/heic',
    ],
    maxBytes: 25 * MB,
    word: 'document',
  },
};

// When the browser sends a general type, the file's ending decides.
const BY_ENDING = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  mp4: 'video/mp4',
  '3gp': 'video/3gpp',
  aac: 'audio/aac',
  amr: 'audio/amr',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
};

const megabytes = (bytes) => `${(bytes / MB).toFixed(1)} MB`;

/** A file name as typed on the person's computer (multer reads non-English names as latin1). */
export function cleanFileName(name) {
  const raw = String(name ?? 'file');
  const codes = [...raw].map((char) => char.codePointAt(0));
  const decoded = Buffer.from(raw, 'latin1').toString('utf8');
  // Only when the name was really UTF-8 read as latin1: some characters between 128 and 255,
  // none above, and a clean result.
  const fixed =
    codes.some((code) => code >= 128) &&
    codes.every((code) => code <= 255) &&
    !decoded.includes(String.fromCharCode(0xfffd))
      ? decoded
      : raw;
  return (
    fixed
      .replace(/[\\/:*?"<>|]/g, '_')
      // eslint-disable-next-line no-control-regex -- control characters do not belong in a file name
      .replace(/[\u0000-\u001f]/g, '')
      .trim()
      .slice(0, 200) || 'file'
  );
}

/**
 * Which WhatsApp kind a file is sent as, or a plain-word refusal.
 * @param {{ mimeType?: string, fileName: string, size: number }} file
 * @returns {{ kind: 'image' | 'video' | 'audio' | 'document', mimeType: string }}
 */
export function classifyFile({ mimeType, fileName, size }) {
  const ending = String(fileName).split('.').pop()?.toLowerCase() ?? '';
  let type = String(mimeType ?? '')
    .toLowerCase()
    .split(';')[0]
    .trim();
  const isKnown = Object.values(KINDS).some((kind) => kind.types.includes(type));
  if (!isKnown && BY_ENDING[ending]) type = BY_ENDING[ending];
  const entry = Object.entries(KINDS).find(([, kind]) => kind.types.includes(type));
  if (!entry) {
    throw badRequest(
      `This file type (${ending || type || 'unknown'}) can't be sent on WhatsApp. Send images, PDF, Word, Excel, PowerPoint, text, audio or video.`,
    );
  }
  const [kind, rule] = entry;
  if (size > rule.maxBytes) {
    throw badRequest(
      `${rule.word[0].toUpperCase()}${rule.word.slice(1)} files can be at most ${rule.maxBytes / MB} MB on WhatsApp (this one is ${megabytes(size)}).`,
    );
  }
  return { kind, mimeType: type };
}

/**
 * Keep a file of a conversation in S3.
 * @returns {Promise<string>}  The S3 address (saved on the message)
 */
export function storeWhatsAppFile(conversationId, { buffer, mimeType, fileName }) {
  const safeName = cleanFileName(fileName).replace(/\s+/g, '-');
  const key = `whatsapp/${conversationId}/${randomBytes(6).toString('hex')}-${safeName}`;
  return uploadObject({ key, body: buffer, contentType: mimeType });
}

/**
 * Fetch the file of a customer's message from Meta and keep it. Safe to run twice: a message
 * whose file is no longer "pending" is left alone.
 * @param {string} messageId
 * @param {{ isLastAttempt?: boolean }} [options]  On the last try a failure marks it "failed"
 */
export async function saveIncomingMedia(messageId, { isLastAttempt = true } = {}) {
  const message = await WhatsAppMessage.findById(messageId).lean();
  if (!message?.media || message.media.status !== 'pending') return 'skipped';
  const markFailed = () =>
    WhatsAppMessage.updateOne(
      { _id: message._id, 'media.status': 'pending' },
      { $set: { 'media.status': 'failed' } },
    );
  if (!isStorageConfigured() || !message.media.providerMediaId) {
    await markFailed();
    return 'failed';
  }
  try {
    const file = await downloadWhatsAppMedia(message.media.providerMediaId);
    const mimeType = message.media.mimeType || file.mimeType;
    const url = await storeWhatsAppFile(message.conversationId, {
      buffer: file.buffer,
      mimeType,
      fileName: message.media.fileName || `whatsapp-${message.type}`,
    });
    await WhatsAppMessage.updateOne(
      { _id: message._id, 'media.status': 'pending' },
      {
        $set: {
          'media.url': url,
          'media.size': file.size,
          'media.mimeType': mimeType,
          'media.status': 'ready',
        },
      },
    );
    return 'ready';
  } catch (error) {
    // Too large never gets better; anything else is tried again by the queue.
    if (isLastAttempt || error?.code === 'WHATSAPP_FILE_TOO_LARGE') {
      logger.warn({ err: error, messageId }, 'A WhatsApp file could not be saved');
      await markFailed();
      return 'failed';
    }
    throw error;
  }
}

/**
 * Fetch an incoming file in the background. Without the queue (Redis down) it is fetched at
 * once, so a file is never left waiting.
 */
export async function queueIncomingMedia(messageId) {
  try {
    await enqueue('messaging', JOB_NAMES.whatsappMedia, { messageId: String(messageId) });
  } catch {
    await saveIncomingMedia(messageId).catch((error) =>
      logger.warn({ err: error, messageId }, 'A WhatsApp file could not be saved'),
    );
  }
}
