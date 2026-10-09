import { Router } from 'express';
import { getBackups, postBackup } from '../controllers/backups.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { authorize } from '../middleware/authorize.js';

// Database backups (Settings → Backups). Needs the "settings" permission, which by default only
// the CEO account type holds. There is no route to download or restore a backup: a restore is
// done from the command line (docs/runbooks), on purpose.
const router = Router();

router.use(requireAuth);

router.get('/', authorize('settings', 'view'), getBackups);
router.post('/', authorize('settings', 'edit'), postBackup);

export default router;
