import mongoose from 'mongoose';
import { logger } from './logger.js';

// The only place that opens or closes the MongoDB connection.

/**
 * Connect to MongoDB. Fails fast (10s) so a wrong URI is noticed at startup, not on the first request.
 * @param {string} uri
 */
export async function connectMongo(uri) {
  // Reject queries on fields that are not in the schema instead of silently ignoring them.
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  logger.info({ database: mongoose.connection.name }, 'MongoDB connected');
}

export async function disconnectMongo() {
  await mongoose.disconnect();
}

/**
 * True when the database answers a ping within the timeout.
 * Used by the health check; never throws.
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export async function isMongoUp(timeoutMs = 2000) {
  // readyState 1 means "connected".
  if (mongoose.connection.readyState !== 1) return false;
  try {
    await Promise.race([
      mongoose.connection.db.admin().ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('ping timeout')), timeoutMs)),
    ]);
    return true;
  } catch {
    return false;
  }
}
