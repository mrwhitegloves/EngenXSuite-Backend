import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  createApiLimiter,
  createLoginLimiter,
  createLoginPerEmailLimiter,
} from '../middleware/rateLimit.js';
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

describe('general API limit', () => {
  // A tiny app: a fake session from a header, then the limiter, then a few routes.
  function makeApiApp(limit) {
    const app = express();
    app.set('trust proxy', 1);
    app.use((req, res, next) => {
      const userId = req.get('x-test-user');
      req.session = userId ? { userId } : {};
      next();
    });
    app.use('/api', createApiLimiter({ limit, skip: () => false }));
    app.get('/api/things', (req, res) => res.json({ data: 'ok' }));
    app.get('/api/health/live', (req, res) => res.json({ data: 'ok' }));
    app.post('/api/webhooks/plivo/x', (req, res) => res.json({ data: 'ok' }));
    app.use(errorHandler);
    return app;
  }
  const get = (app, path, { user, address = '203.0.113.9' } = {}) =>
    request(app)
      .get(path)
      .set('X-Forwarded-For', address)
      .set(user ? { 'x-test-user': user } : {});

  it('counts a signed-in user by user, wherever they come from', async () => {
    const app = makeApiApp(3);
    const statuses = [];
    for (let count = 0; count < 5; count += 1) {
      statuses.push(
        (await get(app, '/api/things', { user: 'u1', address: `198.51.100.${count + 1}` })).status,
      );
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);

    // Another user at the very same address has their own count.
    expect((await get(app, '/api/things', { user: 'u2', address: '198.51.100.1' })).status).toBe(
      200,
    );
    const blocked = await get(app, '/api/things', { user: 'u1' });
    expect(blocked.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('counts someone who is not signed in by address', async () => {
    const app = makeApiApp(2);
    expect((await get(app, '/api/things')).status).toBe(200);
    expect((await get(app, '/api/things')).status).toBe(200);
    expect((await get(app, '/api/things')).status).toBe(429);
    expect((await get(app, '/api/things', { address: '203.0.113.10' })).status).toBe(200);
  });

  it('never counts health checks and provider webhooks', async () => {
    const app = makeApiApp(1);
    for (let count = 0; count < 4; count += 1) {
      expect((await get(app, '/api/health/live')).status).toBe(200);
      expect((await request(app).post('/api/webhooks/plivo/x')).status).toBe(200);
    }
  });
});

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
