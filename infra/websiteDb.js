import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from './logger.js';

// The only place that talks to the engenx.in WEBSITE's database (a different database from the
// CRM's). The CRM only reads it: visitor pageviews and contact-form leads written by the
// website (Next-Engenx). Nothing is ever written here.
//
// A second connection, opened on first use. mongoose.disconnect() at shutdown closes it too.

let connection = null;

export const isWebsiteDbConfigured = () => Boolean(env.WEBSITE_MONGODB_URI);

function openConnection() {
  // 1: connected, 2: connecting. A closed one (after a shutdown in tests) is opened again.
  if (connection && [1, 2].includes(connection.readyState)) return connection;
  connection = mongoose.createConnection(env.WEBSITE_MONGODB_URI, {
    dbName: env.WEBSITE_DB_NAME,
    serverSelectionTimeoutMS: 10_000,
    // Only reads: a secondary member may answer.
    readPreference: 'secondaryPreferred',
  });
  connection.on('error', (error) => logger.warn({ err: error }, 'Website database error'));
  return connection;
}

/**
 * A collection of the website's database, for reading.
 * @param {'pageviews' | 'leads'} name
 */
export async function websiteCollection(name) {
  const open = openConnection();
  await open.asPromise();
  return open.db.collection(name);
}
