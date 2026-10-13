import { Router } from 'express';
import {
  getCallById,
  getCalls,
  getFormOptions,
  getRecording,
  getSettings,
  patchCall,
  patchSettings,
  postCall,
  respondConnect,
  respondConsent,
  respondDialResult,
  respondInbound,
  respondNothing,
} from '../controllers/calls.controller.js';
import { getCallTranscript, postCallTranscript } from '../controllers/aiChat.controller.js';
import { createWebhookHandler } from '../controllers/webhooks/receive.js';
import { createAiLimiter } from '../middleware/rateLimit.js';
import { isValidPlivoSignature } from '../integrations/plivo/client.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import {
  listCallsQuery,
  startCallBody,
  updateCallBody,
  updateCallSettingsBody,
} from '../validation/calls.js';
import { idParams } from '../validation/common.js';

// ── Plivo's webhooks (/api/webhooks/plivo/…). No sign-in: Plivo's signature is the check.
// Each is one kind of event of a call; `respond` is what Plivo is told at once (XML).
function plivoWebhook(kind, respond) {
  return createWebhookHandler({
    provider: 'plivo',
    verify: isValidPlivoSignature,
    // One event per call and kind (a recording has its own id); a repeat is recognised.
    getEventId: (req) => {
      const call = req.body?.CallUUID ?? req.query.call;
      return call
        ? `${call}:${kind}:${req.body?.RecordingID ?? ''}${req.query.step ?? ''}`
        : undefined;
    },
    getPayload: (req) => ({
      kind,
      call: req.query.call,
      step: req.query.step,
      params: req.body ?? {},
    }),
    respond,
  });
}

export const plivoWebhooksRouter = Router();
plivoWebhooksRouter.post('/connect', plivoWebhook('connect', respondConnect));
plivoWebhooksRouter.post('/inbound', plivoWebhook('inbound', respondInbound));
plivoWebhooksRouter.post('/consent', plivoWebhook('consent', respondConsent));
plivoWebhooksRouter.post('/dial-result', plivoWebhook('dial-result', respondDialResult));
plivoWebhooksRouter.post('/recording', plivoWebhook('recording', respondNothing));
// The end of a call: nothing to answer but "received".
plivoWebhooksRouter.post('/hangup', plivoWebhook('hangup'));

// ── Calls. authorize() answers "may this person do this at all"; which contact, lead or call
// exactly is decided in the service.
export const callsRouter = Router();
const FEATURE = 'calls';
callsRouter.use(requireAuth);
callsRouter.post('/', authorize(FEATURE, 'create'), validate({ body: startCallBody }), postCall);
callsRouter.get('/', authorize(FEATURE, 'view'), validate({ query: listCallsQuery }), getCalls);
callsRouter.get('/form-options', authorize(FEATURE, 'view'), getFormOptions);
callsRouter.get('/:id', authorize(FEATURE, 'view'), validate({ params: idParams }), getCallById);
callsRouter.patch(
  '/:id',
  authorize(FEATURE, 'edit'),
  validate({ params: idParams, body: updateCallBody }),
  patchCall,
);
callsRouter.get(
  '/:id/recording',
  authorize(FEATURE, 'view'),
  validate({ params: idParams }),
  getRecording,
);

// The text of a call, made from its recording when a person asks for it.
callsRouter.get(
  '/:id/transcript',
  authorize(FEATURE, 'view'),
  validate({ params: idParams }),
  getCallTranscript,
);
callsRouter.post(
  '/:id/transcript',
  authorize(FEATURE, 'view'),
  createAiLimiter(),
  validate({ params: idParams }),
  postCallTranscript,
);

// ── Settings → Calls.
export const callSettingsRouter = Router();
callSettingsRouter.use(requireAuth);
callSettingsRouter.get('/', authorize('settings', 'view'), getSettings);
callSettingsRouter.patch(
  '/',
  authorize('settings', 'edit'),
  validate({ body: updateCallSettingsBody }),
  patchSettings,
);
