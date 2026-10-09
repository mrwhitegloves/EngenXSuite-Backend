import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createLoginLimiter, createLoginPerEmailLimiter } from '../middleware/rateLimit.js';
import { errorHandler } from '../middleware/errorHandler.js';

// A tiny sign-in endpoint that always answers "wrong password", behind one proxy, with both
// sign-in limiters switched on (they are off in other tests).
function makeApp({ perAddress = 3, perEmail = 5 } = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.post(
    '/login',
    createLoginLimiter({ limit: perAddress, skip: () => false }),
    createLoginPerEmailLimiter({ limit: perEmail, skip: () => false }),
    (req, res) => res.status(401).json({ error: { code: 'UNAUTHORIZED' } }),
  );
  app.use(errorHandler);
  return app;
}

const attempt = (app, email, address) =>
  request(app).post('/login').set('X-Forwarded-For', address).send({ email, password: 'guess' });

describe('sign-in limits', () => {
  it('one address is stopped after its limit for that email', async () => {
    const app = makeApp();
    const statuses = [];
    for (let count = 0; count < 4; count += 1) {
      statuses.push((await attempt(app, 'a@engenx.in', '203.0.113.5')).status);
    }
    expect(statuses).toEqual([401, 401, 401, 429]);
    // Another person at the same address is not affected.
    expect((await attempt(app, 'b@engenx.in', '203.0.113.5')).status).toBe(401);
  });

  it('guessing one account from many addresses is stopped as well', async () => {
    const app = makeApp();
    const statuses = [];
    for (let count = 0; count < 7; count += 1) {
      // A different address every time: the per-address limit never triggers.
      statuses.push((await attempt(app, 'ceo@engenx.in', `198.51.100.${count + 1}`)).status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);

    const blocked = await attempt(app, 'CEO@EngenX.in ', '198.51.100.99'); // same account
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    // Other accounts can still sign in.
    expect((await attempt(app, 'agent@engenx.in', '198.51.100.99')).status).toBe(401);
  });
});
