import { SOCKET_EVENTS } from '../constants/socketEvents.js';
import { logger } from '../infra/logger.js';
import { emitToUser } from '../infra/realtime.js';
import { badRequest, notFound } from '../lib/errors.js';
import { buildFilter, runListQuery } from '../lib/queryBuilder.js';
import {
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_KEYS,
  Notification,
} from '../models/notification.model.js';
import { User } from '../models/user.model.js';

// Notifications. notify() is the ONLY way one is created: no other file writes the
// `notifications` collection. This file imports models only, so every service can call it.

const sameId = (a, b) => a != null && b != null && String(a) === String(b);

function toView(notification) {
  return {
    id: String(notification._id),
    type: notification.type,
    title: notification.title,
    body: notification.body ?? null,
    link: notification.link ?? null,
    isRead: Boolean(notification.readAt),
    createdAt: notification.createdAt,
  };
}

/**
 * Tell one person something. Nothing is created (and nothing is sent) when
 *   - the person did it themselves (`actorId` is that person),
 *   - they are not an active user,
 *   - they switched notifications off, or this kind of notification off,
 *   - they were told the same thing already (`dedupeKey`).
 * A problem here is logged and never breaks the action that wanted to notify.
 *
 * @param {{ userId: unknown, type: string, title: string, body?: string, link?: string,
 *           dedupeKey?: string, actorId?: unknown }} message
 * @returns {Promise<object | null>} The notification, or null when none was created
 */
export async function notify({ userId, type, title, body, link, dedupeKey, actorId }) {
  try {
    if (!userId || sameId(userId, actorId)) return null;
    if (!NOTIFICATION_TYPE_KEYS.includes(type)) throw new Error(`Unknown notification "${type}"`);
    const user = await User.findById(userId)
      .select('status notificationsEnabled notificationPrefs')
      .lean();
    if (!user || user.status !== 'active' || !user.notificationsEnabled) return null;
    if (user.notificationPrefs?.[type] === false) return null;

    const notification = await Notification.create({ userId, type, title, body, link, dedupeKey });
    emitToUser(userId, SOCKET_EVENTS.notificationsChanged);
    return toView(notification.toObject());
  } catch (error) {
    // The unique index: this person was told this already.
    if (error?.code !== 11000) {
      logger.error({ err: error, type }, 'Notification could not be created');
    }
    return null;
  }
}

/**
 * The signed-in person's own notifications, newest first.
 * @param {{ unread?: 'true' | 'false', type?: string, search?: string, range?: string,
 *           from?: string, to?: string, page: number, pageSize: number }} query  Validated
 */
export async function listNotifications(actor, query) {
  const { rows, pagination } = await runListQuery(Notification, {
    filter: buildFilter({
      // Always and only one's own.
      scope: { userId: actor._id },
      equals: { type: query.type },
      search: { text: query.search, fields: ['title', 'body'] },
      dates: { field: 'createdAt', query: { range: query.range, from: query.from, to: query.to } },
      extra: [query.unread === 'true' ? { readAt: null } : null],
    }),
    sort: { createdAt: -1, _id: -1 },
    page: query.page,
    pageSize: query.pageSize,
  });
  return { items: rows.map(toView), pagination };
}

/** How many of the person's notifications are unread (the number on the bell). */
export async function countUnread(actor) {
  return { unread: await Notification.countDocuments({ userId: actor._id, readAt: null }) };
}

/** Mark one of the person's own notifications as read. */
export async function markRead(actor, notificationId) {
  const mine = { _id: notificationId, userId: actor._id };
  // Only when it is still unread: reading it again keeps the first time.
  await Notification.updateOne({ ...mine, readAt: null }, { $set: { readAt: new Date() } });
  const notification = await Notification.findOne(mine).lean();
  if (!notification) throw notFound('Notification not found');
  emitToUser(actor._id, SOCKET_EVENTS.notificationsChanged);
  return toView(notification);
}

export async function markAllRead(actor) {
  const result = await Notification.updateMany(
    { userId: actor._id, readAt: null },
    { $set: { readAt: new Date() } },
  );
  emitToUser(actor._id, SOCKET_EVENTS.notificationsChanged);
  return { marked: result.modifiedCount };
}

/** The person's switches: the master switch and one per kind of notification. */
export async function getPreferences(actor) {
  const user = await User.findById(actor._id)
    .select('notificationsEnabled notificationPrefs')
    .lean();
  return {
    enabled: user.notificationsEnabled,
    types: NOTIFICATION_TYPE_KEYS.map((type) => ({
      type,
      label: NOTIFICATION_TYPES[type],
      // On unless the person switched it off.
      enabled: user.notificationPrefs?.[type] !== false,
    })),
  };
}

/**
 * Change the switches. Switching notifications on again does not bring back what was not
 * created while they were off.
 * @param {{ enabled?: boolean, types?: Record<string, boolean> }} changes  Validated
 */
export async function updatePreferences(actor, changes) {
  const set = {};
  if (changes.enabled !== undefined) set.notificationsEnabled = changes.enabled;
  for (const [type, isOn] of Object.entries(changes.types ?? {})) {
    if (!NOTIFICATION_TYPE_KEYS.includes(type)) {
      throw badRequest('Not a kind of notification', [{ field: 'types' }]);
    }
    set[`notificationPrefs.${type}`] = isOn;
  }
  if (Object.keys(set).length > 0) await User.updateOne({ _id: actor._id }, { $set: set });
  emitToUser(actor._id, SOCKET_EVENTS.meChanged);
  return getPreferences(actor);
}
