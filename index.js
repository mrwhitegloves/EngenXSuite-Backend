import { env } from './config/env.js';
import { logger } from './infra/logger.js';
import { connectMongo, disconnectMongo } from './infra/mongo.js';
import { runPendingMigrations } from './infra/migrations.js';
import { configureGoogleAuth } from './infra/googleAuth.js';
import { createSessionMiddleware } from './middleware/session.js';
import { connectRedis, disconnectRedis } from './infra/redis.js';
import { closeQueues } from './infra/queues.js';
import { startWorkers, stopWorkers } from './infra/workers.js';
import { JOB_HANDLERS } from './jobs/index.js';
import { registerSchedules } from './jobs/schedules.js';
import { startRealtime, stopRealtime } from './infra/realtime.js';
import { loadRequestUser } from './services/auth.service.js';
import { verifyTicket } from './lib/realtimeTicket.js';
import { flushSentry, initSentry, reportError } from './infra/sentry.js';
import { createApp } from './app.js';

// Entry point: connect to what the app needs, start listening, and shut down cleanly.

async function start() {
  initSentry();
  await connectMongo(env.DATABASE_URI);
  // Bring the data up to what this code expects, before any request is served.
  await runPendingMigrations();
  // Redis connects in the background; the server does not wait for it and runs without it.
  connectRedis();
  logger.info({ database: env.DATABASE_KIND }, 'Using database');

  configureGoogleAuth();
  const sessionMiddleware = createSessionMiddleware();
  const app = createApp({ sessionMiddleware });
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'Server listening');
  });
  // Live updates share the HTTP server. A browser connects with a ticket from the API.
  startRealtime(server, {
    verifyTicket,
    loadUser: loadRequestUser,
    allowedOrigins: [new URL(env.APP_URL).origin],
  });
  // Background jobs run inside this same process. Without Redis they are simply off.
  startWorkers(JOB_HANDLERS);
  // Jobs that run by the clock (production only). Not awaited: it waits for Redis by itself.
  registerSchedules();

  // Cloud Run sends SIGTERM before stopping an instance. Stop taking new requests,
  // let running ones finish, then close the database connection.
  async function shutdown(signal) {
    logger.info({ signal }, 'Shutting down');
    // Open live connections would keep the server from closing.
    stopRealtime();
    server.close(async () => {
      await stopWorkers();
      await closeQueues();
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
