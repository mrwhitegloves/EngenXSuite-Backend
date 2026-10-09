import express from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import apiRoutes from './routes/index.js';
import { passport } from './infra/googleAuth.js';
import { requestLogger } from './middleware/requestId.js';
import { createCsrfProtection } from './middleware/csrf.js';
import { apiNotFound, errorHandler } from './middleware/errorHandler.js';

/**
 * Build the Express app. Kept separate from index.js so tests can create the app
 * without opening a port.
 *
 * This server is API-only. The React client is a separate project and repository, hosted on
 * Vercel; its /api calls are forwarded to this server, so the browser sees one origin.
 *
 * @param {{ sessionMiddleware?: import('express').RequestHandler }} [options]
 *   The session middleware needs a live MongoDB connection, so index.js creates it after
 *   connecting and passes it in. Without it, every protected route answers 401.
 */
export function createApp({ sessionMiddleware } = {}) {
  const app = express();

  // Proxies in front of the app add the visitor's address to a header. Trusting exactly the
  // right number of them makes req.ip the real visitor, which the rate limiter depends on:
  // too few and everyone shares one address, too many and a visitor can fake theirs.
  // Cloud Run is 1; requests that also pass through the client's host are 2 (TRUST_PROXY_HOPS).
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  app.disable('x-powered-by');

  app.use(requestLogger);
  app.use(helmet());
  // Refuses changing requests that another website makes a signed-in browser send.
  app.use(createCsrfProtection());
  app.use(express.json({ limit: '1mb' }));
  if (sessionMiddleware) app.use(sessionMiddleware);
  app.use(passport.initialize());

  app.use('/api', apiRoutes);
  app.use(apiNotFound);

  app.use(errorHandler);
  return app;
}
