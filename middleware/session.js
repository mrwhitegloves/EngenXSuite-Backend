import session from 'express-session';
import MongoStore from 'connect-mongo';
import mongoose from 'mongoose';
import { env } from '../config/env.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
export const SESSION_COOKIE_NAME = 'sid';
export const SESSION_COLLECTION = 'sessions';

/**
 * Server-side sessions stored in MongoDB. The browser holds only a signed, random session id.
 * Sessions are in MongoDB (not Redis) on purpose: Redis is allowed to fail or be flushed, and
 * nobody should be signed out by that.
 *
 * Must be called after MongoDB is connected.
 */
export function createSessionMiddleware() {
  return session({
    name: SESSION_COOKIE_NAME,
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    // Each request moves the expiry forward, so an active user stays signed in.
    rolling: true,
    store: MongoStore.create({
      client: mongoose.connection.getClient(),
      collectionName: SESSION_COLLECTION,
      // Session data is stored as a readable object so all sessions of one user can be found
      // and removed when that user is deactivated.
      stringify: false,
      ttl: (7 * ONE_DAY_MS) / 1000,
    }),
    cookie: {
      httpOnly: true, // JavaScript in the page cannot read it
      secure: env.NODE_ENV === 'production', // HTTPS only in production
      sameSite: 'lax', // not sent on cross-site POSTs: the main CSRF protection
      maxAge: 7 * ONE_DAY_MS,
    },
  });
}
