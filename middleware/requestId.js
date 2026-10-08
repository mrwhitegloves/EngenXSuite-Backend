import { randomUUID } from 'node:crypto';
import pinoHttp from 'pino-http';
import { logger } from '../infra/logger.js';

// Gives every request an id, logs the request with it, and returns it in the
// "X-Request-Id" header so one request can be followed through the logs.
export const requestLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const id = randomUUID();
    res.setHeader('X-Request-Id', id);
    return id;
  },
  // Health checks are called every few seconds by the platform; logging them is noise.
  autoLogging: { ignore: (req) => req.url.startsWith('/api/health') },
});
