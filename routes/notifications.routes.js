import { Router } from 'express';
import {
  getNotificationPreferences,
  getNotifications,
  getUnreadCount,
  patchNotificationPreferences,
  postRead,
  postReadAll,
} from '../controllers/notifications.controller.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import { idParams } from '../validation/common.js';
import {
  listNotificationsQuery,
  notificationPreferencesBody,
} from '../validation/notifications.js';

// A person's own notifications. There is no permission to check: every signed-in user has
// notifications, and the service only ever reads and changes the signed-in person's own.
const router = Router();

router.use(requireAuth);

router.get('/', validate({ query: listNotificationsQuery }), getNotifications);
router.get('/unread-count', getUnreadCount);
router.get('/preferences', getNotificationPreferences);
router.patch(
  '/preferences',
  validate({ body: notificationPreferencesBody }),
  patchNotificationPreferences,
);
router.post('/read-all', postReadAll);
router.post('/:id/read', validate({ params: idParams }), postRead);

export default router;
