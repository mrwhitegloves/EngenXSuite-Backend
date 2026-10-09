import { Router } from 'express';
import { getAuditLogs, getAuditOptions } from '../controllers/audit.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { listAuditLogsQuery } from '../validation/audit.js';

// The audit log (Settings → Audit log). Read-only: there is no route that writes, changes or
// deletes an entry. Needs the "audit" permission, which by default only the CEO holds.
const router = Router();

router.use(requireAuth);

router.get('/', authorize('audit', 'view'), validate({ query: listAuditLogsQuery }), getAuditLogs);
router.get('/options', authorize('audit', 'view'), getAuditOptions);

export default router;
