import { createHash } from 'node:crypto';
import { createAppError } from '../../lib/errors.js';
import { receiveWebhook } from '../../services/webhooks.service.js';

/**
 * Build the request handler for one provider's webhook. Every provider uses this, so every
 * webhook is verified, stored, de-duplicated and answered the same way.
 *
 *   router.post('/plivo/call-status', createWebhookHandler({
 *     provider: 'plivo',
 *     verify: (req) => isValidPlivoSignature(req),      // true only when the signature is right
 *     getEventId: (req) => req.body.CallUUID,           // the provider's id of this event
 *   }));
 *
 * The handler answers 200 as soon as the event is stored; the real work happens in a
 * background job (services/webhooks.service.js). `req.rawBody` holds the exact bytes received,
 * for signature checks.
 *
 * Some webhooks are a question that needs an answer in the provider's own format (Plivo asks
 * "what shall I do with this call?" and wants XML). For those, pass `respond`: it writes the
 * answer once the event is stored. It must be quick; slow work still belongs in the job.
 *
 * @param {{ provider: string,
 *           verify: (req: import('express').Request) => boolean | Promise<boolean>,
 *           getEventId?: (req: import('express').Request) => string | undefined,
 *           getPayload?: (req: import('express').Request) => unknown,
 *           respond?: (req: import('express').Request, res: import('express').Response) => unknown,
 *         }} options
 *        getPayload: what to store as the event (default: the request body)
 */
export function createWebhookHandler({ provider, verify, getEventId, getPayload, respond }) {
  return async function handleWebhook(req, res, next) {
    let signatureValid = false;
    try {
      signatureValid = (await verify(req)) === true;
    } catch {
      // A check that throws is a failed check.
      signatureValid = false;
    }

    // Without an id from the provider, the same body counts as the same event.
    const body = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const eventId = String(
      getEventId?.(req) || createHash('sha256').update(body).digest('hex'),
    ).slice(0, 200);

    const payload = getPayload ? getPayload(req) : req.body;
    const result = await receiveWebhook({ provider, eventId, payload, signatureValid });
    if (!result.accepted) {
      return next(createAppError('INVALID_SIGNATURE', 401, 'The signature check failed.'));
    }
    if (respond) return respond(req, res);
    return res.status(200).json({ data: { received: true } });
  };
}
