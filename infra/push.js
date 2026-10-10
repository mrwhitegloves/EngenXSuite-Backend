import webpush from 'web-push';
import { env } from '../config/env.js';
import { logger } from './logger.js';

// The only file that talks to the browsers' push services (web push).
// A push is a small message a browser shows as a system notification, also when the app's tab
// is closed. It needs a key pair (VAPID); without the keys push is simply off and everything
// else works as before.

let isReady = false;

export function isPushConfigured() {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

/** The public half of the key pair: the browser needs it to subscribe. null when push is off. */
export function pushPublicKey() {
  return isPushConfigured() ? env.VAPID_PUBLIC_KEY : null;
}

/**
 * Send one push to one browser.
 * @param {{ endpoint: string, keys: { p256dh: string, auth: string } }} subscription
 * @param {{ title: string, body?: string, link?: string }} message
 * @returns {Promise<'sent' | 'gone' | 'failed'>}
 *          gone: the browser no longer accepts this subscription (remove it); never throws
 */
export async function sendPush(subscription, message) {
  if (!isPushConfigured()) return 'failed';
  if (!isReady) {
    webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
    isReady = true;
  }
  try {
    await webpush.sendNotification(subscription, JSON.stringify(message), {
      // The push service keeps it for a day when the device is off.
      TTL: 24 * 60 * 60,
    });
    return 'sent';
  } catch (error) {
    // 404 and 410: the subscription was removed or has expired.
    if (error?.statusCode === 404 || error?.statusCode === 410) return 'gone';
    logger.warn({ err: error, statusCode: error?.statusCode }, 'Push could not be sent');
    return 'failed';
  }
}
