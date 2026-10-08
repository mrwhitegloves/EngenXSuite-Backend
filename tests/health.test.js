import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';

// No database is connected in this file on purpose: it checks how the app behaves without one.
const app = createApp();

describe('health endpoints', () => {
  it('GET /api/health/live answers ok without checking dependencies', async () => {
    const response = await request(app).get('/api/health/live');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { status: 'ok' } });
  });

  it('GET /api/health reports 503 and mongo down when the database is not connected', async () => {
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(503);
    expect(response.body.data).toEqual({ status: 'down', components: { mongo: 'down' } });
  });

  it('returns a request id header on every response', async () => {
    const response = await request(app).get('/api/health/live');
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('standard error format', () => {
  it('unknown API route gives 404 in the standard shape', async () => {
    const response = await request(app).get('/api/does-not-exist');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error.requestId).toBe(response.headers['x-request-id']);
  });

  it('malformed JSON gives a clean 400, not a stack trace', async () => {
    const response = await request(app)
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send('{ not json');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
    expect(JSON.stringify(response.body)).not.toMatch(/SyntaxError|at /);
  });

  it('does not reveal the framework', async () => {
    const response = await request(app).get('/api/health/live');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});
