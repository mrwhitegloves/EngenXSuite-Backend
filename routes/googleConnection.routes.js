import { Router } from 'express';
import {
  finishConnect,
  getConnection,
  patchSignature,
  removeConnection,
  startConnect,
} from '../controllers/googleConnection.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import { signatureBody } from '../validation/emails.js';

// The company mailbox (/api/integrations/google). Every signed-in person may look at it;
// connecting, the signature and removing it need the "settings" permission, checked in the
// service on every step.
const router = Router();

router.use(requireAuth);
router.get('/', getConnection);
router.get('/connect', startConnect);
router.get('/callback', finishConnect);
router.patch('/signature', validate({ body: signatureBody }), patchSignature);
router.delete('/', removeConnection);

export default router;
