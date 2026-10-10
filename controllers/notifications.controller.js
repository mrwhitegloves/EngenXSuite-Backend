import {
  countUnread,
  getPreferences,
  listNotifications,
  markAllRead,
  markRead,
  updatePreferences,
} from '../services/notifications.service.js';
import { sendList, sendOk } from '../lib/respond.js';

// A person's own notifications.
// Each function: read the validated request, call one service function, respond.

// GET /api/notifications
export async function getNotifications(req, res) {
  const { items, pagination } = await listNotifications(req.user, req.validated.query);
  sendList(res, items, pagination);
}

// GET /api/notifications/unread-count: the number on the bell.
export async function getUnreadCount(req, res) {
  sendOk(res, await countUnread(req.user));
}

// GET /api/notifications/preferences
export async function getNotificationPreferences(req, res) {
  sendOk(res, await getPreferences(req.user));
}

// PATCH /api/notifications/preferences
export async function patchNotificationPreferences(req, res) {
  sendOk(res, await updatePreferences(req.user, req.validated.body));
}

// POST /api/notifications/read-all
export async function postReadAll(req, res) {
  sendOk(res, await markAllRead(req.user));
}

// POST /api/notifications/:id/read
export async function postRead(req, res) {
  sendOk(res, await markRead(req.user, req.validated.params.id));
}
