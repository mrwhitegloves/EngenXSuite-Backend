import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// The queue is replaced by a list, and can be switched to "not available" (Redis down).
const state = { queueUp: true, enqueued: [] };
vi.mock('../infra/queues.js', () => ({
  enqueue: async (queue, name, data, options) => {
    if (!state.queueUp) throw Object.assign(new Error('queue down'), { status: 503 });
    // Like the real queue: the same job id is added only once.
    if (!state.enqueued.some((job) => job.options.jobId === options.jobId)) {
      state.enqueued.push({ queue, name, data, options });
    }
    return { id: options.jobId };
  },
}));

const { createApp } = await import('../app.js');
const { createWebhookHandler } = await import('../controllers/webhooks/receive.js');
const { errorHandler } = await import('../middleware/errorHandler.js');
const { WebhookEvent } = await import('../models/webhookEvent.model.js');
const { processWebhookEvent, registerWebhookProcessor, requeueWaitingWebhooks } =
  await import('../services/webhooks.service.js');
const { JOB_HANDLERS, JOB_NAMES } = await import('../jobs/index.js');
const { clearTestDb, startTestDb, stopTestDb } = await import('./helpers/testDb.js');

// A made-up provider endpoint, mounted the way a real one will be: under /api/webhooks/, signed
// with a shared secret over the exact bytes of the body.
const SECRET = 'test-webhook-secret';
const sign = (text) => createHmac('sha256', SECRET).update(text).digest('hex');
let app;
let handled;

function makeApp() {
  const server = express();
  const router = express.Router();
  router.post(
    '/website/lead',
    createWebhookHandler({
      provider: 'website',
      verify: (req) => req.get('x-signature') === sign(req.rawBody),
      getEventId: (req) => req.body.id,
    }),
  );
  router.post('/website/no-id', createWebhookHandler({ provider: 'website', verify: () => true }));
  router.post(
    '/website/broken-check',
    createWebhookHandler({
      provider: 'website',
      verify: () => {
        throw new Error('check crashed');
      },
    }),
  );
  // The real app first (it sets up body reading with the raw bytes), then these test routes.
  server.use((req, res, next) => (req.path.startsWith('/api/webhooks/') ? next() : next('route')));
  server.use(express.json({ verify: (req, res, buffer) => (req.rawBody = buffer) }));
  server.use('/api/webhooks', router);
  server.use(errorHandler);
  return server;
}

const send = (path, body, signature) => {
  const text = JSON.stringify(body);
  return request(app)
    .post(`/api/webhooks${path}`)
    .set('Content-Type', 'application/json')
    .set('x-signature', signature ?? sign(text))
    .send(text);
};

beforeAll(async () => {
  await startTestDb();
  app = makeApp();
});
afterAll(stopTestDb);

beforeEach(async () => {
  await clearTestDb();
  state.queueUp = true;
  state.enqueued = [];
  handled = [];
  registerWebhookProcessor('website', async (event) => {
    if (event.payload.explode) throw new Error('downstream service is down');
    handled.push(event.payload);
  });
});

const runJob = (webhookEventId) =>
  JOB_HANDLERS[JOB_NAMES.webhookProcess]({ webhookEventId }, { jobId: '1', attempt: 1 });

describe('webhook receiver', () => {
  it('stores a signed event, answers at once, and queues one job with only the event id', async () => {
    const response = await send('/website/lead', { id: 'evt-1', name: 'Steel Works' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { received: true } });
    expect(handled).toEqual([]); // nothing is handled inside the request

    const event = await WebhookEvent.findOne({ eventId: 'evt-1' }).lean();
    expect(event).toMatchObject({
      provider: 'website',
      signatureValid: true,
      status: 'queued',
      payload: { id: 'evt-1', name: 'Steel Works' },
    });
    expect(state.enqueued).toHaveLength(1);
    expect(state.enqueued[0]).toMatchObject({
      queue: 'webhooks',
      name: JOB_NAMES.webhookProcess,
      data: { webhookEventId: String(event._id) },
    });
  });

  it('the same event sent again is answered "ok" but stored and queued only once', async () => {
    await send('/website/lead', { id: 'evt-1', name: 'Steel Works' });
    const again = await send('/website/lead', { id: 'evt-1', name: 'Steel Works' });
    expect(again.status).toBe(200);
    expect(await WebhookEvent.countDocuments()).toBe(1);
    expect(state.enqueued).toHaveLength(1);
  });

  it('refuses a wrong or missing signature and never processes it', async () => {
    const forged = await send('/website/lead', { id: 'evt-9', name: 'Fake' }, 'not-the-signature');
    expect(forged.status).toBe(401);
    expect(forged.body.error.code).toBe('INVALID_SIGNATURE');
    expect((await send('/website/broken-check', { id: 'evt-8' })).status).toBe(401);
    expect(state.enqueued).toEqual([]);

    const stored = await WebhookEvent.find().lean();
    expect(stored).toHaveLength(2);
    for (const event of stored) {
      expect(event).toMatchObject({ signatureValid: false, status: 'ignored' });
      expect(JSON.stringify(event.payload)).not.toContain('Fake'); // the body is not kept
      // Kept for one day only.
      expect(event.expiresAt - event.createdAt).toBeLessThan(25 * 60 * 60 * 1000);
      expect(await processWebhookEvent(event._id)).toBe('ignored');
    }
    expect(handled).toEqual([]);
  });

  it('a forged request cannot block the real event with the same id', async () => {
    await send('/website/lead', { id: 'evt-1', name: 'Fake' }, 'bad');
    const real = await send('/website/lead', { id: 'evt-1', name: 'Real' });
    expect(real.status).toBe(200);
    const event = await WebhookEvent.findOne({ eventId: 'evt-1' }).lean();
    expect(event.payload.name).toBe('Real');
    expect(state.enqueued).toHaveLength(1);
  });

  it('without an id from the provider, the same body counts as the same event', async () => {
    await send('/website/no-id', { name: 'Same' });
    await send('/website/no-id', { name: 'Same' });
    await send('/website/no-id', { name: 'Different' });
    expect(await WebhookEvent.countDocuments()).toBe(2);
  });

  it('the job handles the event once, even when the job runs twice', async () => {
    await send('/website/lead', { id: 'evt-1', name: 'Steel Works' });
    const event = await WebhookEvent.findOne().lean();
    expect(await runJob(String(event._id))).toEqual({ result: 'processed' });
    expect(await runJob(String(event._id))).toEqual({ result: 'processed' });
    expect(handled).toEqual([{ id: 'evt-1', name: 'Steel Works' }]);

    const after = await WebhookEvent.findById(event._id).lean();
    expect(after).toMatchObject({ status: 'processed', attempts: 1 });
    expect(after.processedAt).toBeInstanceOf(Date);
    expect(await runJob('0123456789abcdef01234567')).toEqual({ result: 'missing' });
  });

  it('a failing processor marks the event failed and lets the queue retry; a retry can succeed', async () => {
    await send('/website/lead', { id: 'evt-1', explode: true });
    const event = await WebhookEvent.findOne().lean();
    await expect(runJob(String(event._id))).rejects.toThrow('downstream service is down');
    await expect(runJob(String(event._id))).rejects.toThrow();
    expect(await WebhookEvent.findById(event._id).lean()).toMatchObject({
      status: 'failed',
      attempts: 2,
      error: 'downstream service is down',
    });

    // The downstream problem is fixed: the next attempt works.
    await WebhookEvent.updateOne({ _id: event._id }, { $set: { 'payload.explode': false } });
    expect(await runJob(String(event._id))).toEqual({ result: 'processed' });
    const after = await WebhookEvent.findById(event._id).lean();
    expect(after).toMatchObject({ status: 'processed', attempts: 3 });
    expect(after.error).toBeUndefined();
  });

  it('an event for a provider without a processor is kept and marked ignored', async () => {
    const event = await WebhookEvent.create({
      provider: 'plivo',
      eventId: 'call-1',
      payload: { a: 1 },
      signatureValid: true,
      expiresAt: new Date(Date.now() + 1000),
    });
    expect(await processWebhookEvent(event._id)).toBe('ignored');
    expect((await WebhookEvent.findById(event._id).lean()).error).toMatch(/No processor/);
  });

  it('with the queue down the event is still stored and answered, and is queued later', async () => {
    state.queueUp = false;
    const response = await send('/website/lead', { id: 'evt-1', name: 'Steel Works' });
    expect(response.status).toBe(200);
    expect((await WebhookEvent.findOne().lean()).status).toBe('received');

    // The sweep job: nothing while the queue is down, and nothing for a very fresh event.
    const later = new Date(Date.now() + 5 * 60 * 1000);
    expect(await requeueWaitingWebhooks({ now: later })).toBe(0);
    state.queueUp = true;
    expect(await requeueWaitingWebhooks({ now: new Date() })).toBe(0);
    expect(await requeueWaitingWebhooks({ now: later })).toBe(1);
    expect((await WebhookEvent.findOne().lean()).status).toBe('queued');
    expect(state.enqueued).toHaveLength(1);
    // Running the sweep again queues nothing new.
    expect(await JOB_HANDLERS[JOB_NAMES.webhookSweep]({}, {})).toEqual({ queued: 0 });
  });

  it('the sweep also re-queues an event whose job was lost long ago', async () => {
    await send('/website/lead', { id: 'evt-1' });
    state.enqueued = []; // the queue lost it (Redis was emptied)
    expect(await requeueWaitingWebhooks({ now: new Date(Date.now() + 10 * 60 * 1000) })).toBe(0);
    expect(await requeueWaitingWebhooks({ now: new Date(Date.now() + 45 * 60 * 1000) })).toBe(1);
    expect(state.enqueued).toHaveLength(1);
  });

  it('stored events are removed by the database after 90 days', async () => {
    await send('/website/lead', { id: 'evt-1' });
    const event = await WebhookEvent.findOne().lean();
    const days = (event.expiresAt - event.createdAt) / (24 * 60 * 60 * 1000);
    expect(Math.round(days)).toBe(90);
    const indexes = await WebhookEvent.collection.indexes();
    expect(
      indexes.some((index) => index.key.expiresAt === 1 && index.expireAfterSeconds === 0),
    ).toBe(true);
  });
});

describe('webhooks in the real app', () => {
  it('keeps the exact bytes for webhook paths only, and has no webhook route yet', async () => {
    const realApp = createApp();
    // No provider route exists until its phase: unknown webhook paths answer 404, not a crash.
    const response = await request(realApp).post('/api/webhooks/plivo/anything').send({ a: 1 });
    expect(response.status).toBe(404);
  });

  it('a webhook from a provider is not blocked by the cross-site check', async () => {
    // Providers call from servers: no Origin and no Sec-Fetch-Site header.
    const response = await send('/website/lead', { id: 'evt-2' });
    expect(response.status).toBe(200);
  });
});
