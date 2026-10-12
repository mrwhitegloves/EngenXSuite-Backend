import { Router } from 'express';
import {
  finishConnect,
  getConnection,
  removeConnection,
  startConnect,
} from '../controllers/googleConnection.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';

// A person's own Gmail and Calendar connection (/api/integrations/google). Every signed-in
// person may look at their own; whether they may connect (only company addresses) is decided
// in the service, on every step.
const router = Router();

router.use(requireAuth);
router.get('/', getConnection);
router.get('/connect', startConnect);
router.get('/callback', finishConnect);
router.delete('/', removeConnection);

export default router;
