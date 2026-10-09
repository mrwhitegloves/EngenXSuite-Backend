import { env } from './config/env.js';
import { logger } from './infra/logger.js';
import { connectMongo, disconnectMongo } from './infra/mongo.js';
import { configureGoogleAuth } from './infra/googleAuth.js';
import { createSessionMiddleware } from './middleware/session.js';
import { connectRedis, disconnectRedis } from './infra/redis.js';
import { flushSentry, initSentry, reportError } from './infra/sentry.js';
import { createApp } from './app.js';

// Entry point: connect to what the app needs, start listening, and shut down cleanly.

async function start() {
  initSentry();
  await connectMongo(env.DATABASE_URI);
  // Redis connects in the background; the server does not wait for it and runs without it.
  connectRedis();
  logger.info({ database: env.DATABASE_KIND }, 'Using database');

  configureGoogleAuth();
  const app = createApp({ sessionMiddleware: createSessionMiddleware() });
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'Server listening');
  });

  // Cloud Run sends SIGTERM before stopping an instance. Stop taking new requests,
  // let running ones finish, then close the database connection.
  async function shutdown(signal) {
    logger.info({ signal }, 'Shutting down');
    server.close(async () => {
      await disconnectRedis();
      await disconnectMongo();
      await flushSentry();
      process.exit(0);
    });
    // If something hangs, do not wait forever.
    setTimeout(() => process.exit(1), 10_000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(async (error) => {
  logger.fatal({ err: error }, 'Server failed to start');
  reportError(error);
  await flushSentry();
  process.exit(1);
});
