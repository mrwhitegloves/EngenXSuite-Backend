import { QUEUE_SETTINGS } from '../config/queues.js';
import { saveIncomingMedia } from '../services/whatsappMedia.service.js';

/**
 * Fetch the file of a customer's WhatsApp message from Meta and keep it in S3. Safe to run
 * twice: a file that is no longer "pending" is left alone. The last try marks it "failed".
 * @param {{ messageId: string }} data
 */
export function runWhatsAppMediaJob({ messageId }, { attempt = 1 } = {}) {
  return saveIncomingMedia(messageId, {
    isLastAttempt: attempt >= (QUEUE_SETTINGS.messaging?.attempts ?? 1),
  });
}
