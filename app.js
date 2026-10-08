import express from 'express';
import helmet from 'helmet';
import apiRoutes from './routes/index.js';
import { requestLogger } from './middleware/requestId.js';
import { apiNotFound, errorHandler } from './middleware/errorHandler.js';

/**
 * Build the Express app. Kept separate from index.js so tests can create the app
 * without opening a port or a database connection.
 *
 * This server is API-only. The React client is a separate project and repository, hosted on
 * Vercel; its /api calls are forwarded to this server, so the browser sees one origin.
 */
export function createApp() {
  const app = express();

  // Cloud Run puts one proxy in front of the app. Trusting exactly one hop makes req.ip the real
  // client address, which the rate limiter depends on. When requests also pass through Vercel
  // there is a second hop: this number must be re-checked at the first production deploy.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(requestLogger);
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));

  app.use('/api', apiRoutes);
  app.use(apiNotFound);

  app.use(errorHandler);
  return app;
}
