import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { authorize } from '../middleware/authorize.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { DEFAULT_ROLE_GRANTS } from '../constants/permissions.js';

// A tiny app with a fake "signed-in user" taken from a header, to test the middleware in isolation.
function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const roleName = req.get('x-test-role');
    if (roleName) req.user = { _id: 'u1', role: { grants: DEFAULT_ROLE_GRANTS[roleName] } };
    next();
  });

  const body = z.object({ name: z.string().min(1), value: z.coerce.number().int().min(0) });
  const query = z.object({ page: z.coerce.number().int().min(1).default(1) });
  app.post('/things', validate({ body, query }), (req, res) => res.json({ data: req.validated }));
  app.get('/users', authorize('users', 'view'), (req, res) => res.json({ data: 'ok' }));

  app.use(errorHandler);
  return app;
}

const app = makeApp();

describe('validate middleware', () => {
  it('passes parsed and converted values to the controller', async () => {
    const response = await request(app).post('/things?page=2').send({ name: 'A', value: '5' });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ query: { page: 2 }, body: { name: 'A', value: 5 } });
  });

  it('rejects bad input with 400 and one entry per problem field', async () => {
    const response = await request(app).post('/things?page=0').send({ name: '', value: -1 });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
    const fields = response.body.error.details.map((issue) => `${issue.in}.${issue.field}`);
    expect(fields.sort()).toEqual(['body.name', 'body.value', 'query.page']);
  });

  it('strips fields that are not in the schema', async () => {
    const response = await request(app)
      .post('/things')
      .send({ name: 'A', value: 1, isAdmin: true });
    expect(response.body.data.body).toEqual({ name: 'A', value: 1 });
  });
});

describe('authorize middleware', () => {
  it('401 when nobody is signed in', async () => {
    const response = await request(app).get('/users');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });

  it('403 when the role lacks the permission', async () => {
    const response = await request(app).get('/users').set('x-test-role', 'Sales Agent');
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('200 when the role has the permission', async () => {
    const response = await request(app).get('/users').set('x-test-role', 'CEO');
    expect(response.status).toBe(200);
  });
});
