import { env } from './config/env.js';
import { logger } from './infra/logger.js';
import { connectMongo, disconnectMongo } from './infra/mongo.js';
import { createApp } from './app.js';

// Entry point: connect to what the app needs, start listening, and shut down cleanly.

async function start() {
  await connectMongo(env.MONGODB_URI);

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'Server listening');
  });

  // Cloud Run sends SIGTERM before stopping an instance. Stop taking new requests,
  // let running ones finish, then close the database connection.
  async function shutdown(signal) {
    logger.info({ signal }, 'Shutting down');
    server.close(async () => {
      await disconnectMongo();
      process.exit(0);
    });
    // If something hangs, do not wait forever.
    setTimeout(() => process.exit(1), 10_000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((error) => {
  logger.fatal({ err: error }, 'Server failed to start');
  process.exit(1);
});
