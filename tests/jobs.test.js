import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// Tests have no Redis. The queue library is replaced by a small in-memory stand-in that keeps
// jobs in arrays, and Redis is switched between "usable" and "down" with `state.redisUp`.
// (Real retries and back-off are the library's own behaviour; they were checked against the
// real Redis, see docs/progress.md.)
const state = { redisUp: true, broken: false, jobs: new Map(), nextId: 1 };

vi.mock('../infra/redis.js', () => ({
  getRedis: () => (state.redisUp ? {} : null),
  getRedisStatus: () => (state.redisUp ? 'up' : 'down'),
  createQueueConnection: () => ({ quit: async () => {}, on: () => {} }),
}));

// The sign-in rate limiter keeps its counters in memory here, as it does without Redis.
vi.mock('../infra/rateLimitStore.js', async () => {
  const { MemoryStore } = await import('express-rate-limit');
  return { createRateLimitStore: () => new MemoryStore() };
});

vi.mock('bullmq', () => {
  function Queue(name, options) {
    const mine = () => [...state.jobs.values()].filter((job) => job.queue === name);
    const check = () => {
      if (state.broken) throw new Error('redis exploded');
    };
    const wrap = (job) => ({
      ...job,
      isFailed: async () => job.state === 'failed',
      retry: async () => {
        job.state = 'waiting';
      },
      remove: async () => {
        state.jobs.delete(`${name}:${job.id}`);
      },
    });
    return {
      on() {},
      async close() {},
      async add(jobName, data, jobOptions) {
        check();
        const id = jobOptions.jobId ?? String(state.nextId++);
        const key = `${name}:${id}`;
        if (!state.jobs.has(key)) {
          state.jobs.set(key, {
            id,
            queue: name,
            name: jobName,
            data,
            state: 'waiting',
            attemptsMade: 0,
            timestamp: 1_700_000_000_000,
            opts: { ...options.defaultJobOptions, ...jobOptions },
          });
        }
        return state.jobs.get(key);
      },
      async getJobCounts(...types) {
        check();
        return Object.fromEntries(
          types.map((type) => [type, mine().filter((job) => job.state === type).length]),
        );
      },
      async getFailed(start, end) {
        check();
        return mine()
          .filter((job) => job.state === 'failed')
          .slice(start, end + 1)
          .map(wrap);
      },
      async getFailedCount() {
        return mine().filter((job) => job.state === 'failed').length;
      },
      async getJob(id) {
        check();
        const job = state.jobs.get(`${name}:${id}`);
        return job ? wrap(job) : undefined;
      },
    };
  }
  function UnrecoverableError(message) {
    const error = new Error(message);
    error.name = 'UnrecoverableError';
    return error;
  }
  return { Queue, Worker: function Worker() {}, UnrecoverableError };
});

const { createApp } = await import('../app.js');
const { createSessionMiddleware } = await import('../middleware/session.js');
const { Role } = await import('../models/role.model.js');
const { User } = await import('../models/user.model.js');
const { runSeed } = await import('../seeds/seed.js');
const { clearTestDb, startTestDb, stopTestDb } = await import('./helpers/testDb.js');
const { enqueue } = await import('../infra/queues.js');
const { createProcessor, isFinalFailure } = await import('../infra/workers.js');
const { JOB_HANDLERS, JOB_NAMES } = await import('../jobs/index.js');
const { QUEUE_NAMES, QUEUE_SETTINGS } = await import('../config/queues.js');

const PASSWORD = 'correct-horse-battery';
let app;
let ceo;
let manager;
let agent;

async function signedInAs(user) {
  const client = request.agent(app);
  const response = await client
    .post('/api/auth/login')
    .send({ email: user.email, password: PASSWORD });
  expect(response.status).toBe(200);
  return client;
}

/** Mark a stored job as failed, as a worker would after the last attempt. */
function failJob(queue, id, reason = 'provider timed out') {
  const job = state.jobs.get(`${queue}:${id}`);
  job.state = 'failed';
  job.failedReason = reason;
  job.attemptsMade = job.opts.attempts;
  job.finishedOn = 1_700_000_100_000;
}

beforeAll(async () => {
  await startTestDb();
  app = createApp({ sessionMiddleware: createSessionMiddleware() });
});
afterAll(stopTestDb);

beforeEach(async () => {
  state.redisUp = true;
  state.broken = false;
  state.jobs.clear();
  state.nextId = 1;
  await clearTestDb();
  await runSeed({ productName: 'P', companyName: 'C', workspaceDomain: 'engenx.in' });
  const roles = Object.fromEntries((await Role.find()).map((role) => [role.name, role]));
  const makeUser = (email, roleName) =>
    User.create({
      email,
      name: email,
      roleId: roles[roleName]._id,
      status: 'active',
      password: PASSWORD,
    });
  ceo = await makeUser('ceo@engenx.in', 'CEO');
  manager = await makeUser('manager@engenx.in', 'Sales Manager');
  agent = await makeUser('agent@engenx.in', 'Sales Agent');
});

describe('enqueue', () => {
  it('adds a job with the retry settings of its queue', async () => {
    const { id } = await enqueue('webhooks', 'some.job', { eventId: 'abc' });
    const stored = state.jobs.get(`webhooks:${id}`);
    expect(stored).toMatchObject({ name: 'some.job', data: { eventId: 'abc' } });
    expect(stored.opts.attempts).toBe(QUEUE_SETTINGS.webhooks.attempts);
    expect(stored.opts.backoff.type).toBe('exponential');
    expect(stored.opts.removeOnComplete).toBeTruthy(); // finished jobs never pile up in Redis
  });

  it('the same jobId is added only once', async () => {
    await enqueue('ai', 'score.lead', { leadId: '1' }, { jobId: 'score-1' });
    await enqueue('ai', 'score.lead', { leadId: '1' }, { jobId: 'score-1' });
    expect(state.jobs.size).toBe(1);
  });

  it('fails with a clear 503 when Redis is down or errors, and never hangs', async () => {
    state.redisUp = false;
    await expect(enqueue('ai', 'x', {})).rejects.toMatchObject({
      status: 503,
      code: 'QUEUE_UNAVAILABLE',
    });
    state.redisUp = true;
    state.broken = true;
    await expect(enqueue('ai', 'x', {})).rejects.toMatchObject({ status: 503 });
  });

  it('refuses a queue name that does not exist', async () => {
    await expect(enqueue('emails', 'x', {})).rejects.toThrow(/Unknown queue/);
  });
});

describe('worker processor', () => {
  it('calls the handler registered for the job name with the data and the attempt number', async () => {
    const handler = vi.fn(async () => 'done');
    const processJob = createProcessor({ 'demo.job': handler });
    const result = await processJob({
      id: 7,
      name: 'demo.job',
      data: { id: 'a' },
      attemptsMade: 1,
    });
    expect(result).toBe('done');
    expect(handler).toHaveBeenCalledWith({ id: 'a' }, { jobId: '7', attempt: 2 });
  });

  it('a job name without a handler fails without being retried', async () => {
    const processJob = createProcessor({});
    await expect(processJob({ id: 1, name: 'nobody.home', data: {} })).rejects.toMatchObject({
      name: 'UnrecoverableError',
    });
  });

  it("passes the handler's error on, so the library retries the job", async () => {
    const processJob = createProcessor({
      'demo.job': async () => {
        throw new Error('provider down');
      },
    });
    await expect(
      processJob({ id: 1, name: 'demo.job', data: {}, attemptsMade: 0 }),
    ).rejects.toThrow('provider down');
  });

  it('knows which failure is the last one', () => {
    const error = new Error('x');
    expect(isFinalFailure({ attemptsMade: 1, opts: { attempts: 3 } }, error)).toBe(false);
    expect(isFinalFailure({ attemptsMade: 3, opts: { attempts: 3 } }, error)).toBe(true);
    const unrecoverable = Object.assign(new Error('x'), { name: 'UnrecoverableError' });
    expect(isFinalFailure({ attemptsMade: 1, opts: { attempts: 3 } }, unrecoverable)).toBe(true);
  });

  it('the test job runs, is safe to run twice, and fails only when asked to', async () => {
    const ping = JOB_HANDLERS[JOB_NAMES.systemPing];
    const context = { jobId: '1', attempt: 1 };
    expect(await ping({ requestedBy: 'u1' }, context)).toEqual({ ok: true });
    expect(await ping({ requestedBy: 'u1' }, context)).toEqual({ ok: true });
    await expect(ping({ requestedBy: 'u1', shouldFail: true }, context)).rejects.toThrow();
  });
});

describe('background jobs API', () => {
  it('needs a session, and the settings permission', async () => {
    expect((await request(app).get('/api/jobs')).status).toBe(401);
    for (const user of [manager, agent]) {
      const client = await signedInAs(user);
      expect((await client.get('/api/jobs')).status).toBe(403);
      expect((await client.get('/api/jobs/failed?queue=ai')).status).toBe(403);
      expect((await client.post('/api/jobs/test').send({})).status).toBe(403);
      expect((await client.post('/api/jobs/ai/1/retry')).status).toBe(403);
      expect((await client.delete('/api/jobs/ai/1')).status).toBe(403);
    }
  });

  it('shows the totals of all four queues', async () => {
    const client = await signedInAs(ceo);
    await client.post('/api/jobs/test').send({});
    const response = await client.get('/api/jobs');
    expect(response.status).toBe(200);
    expect(response.body.data.redis).toBe('up');
    expect(response.body.data.queues.map((queue) => queue.name)).toEqual(QUEUE_NAMES);
    const integrations = response.body.data.queues.find((queue) => queue.name === 'integrations');
    expect(integrations).toMatchObject({ available: true, waiting: 1, failed: 0 });
  });

  it('the test job holds only the id of who asked for it', async () => {
    const client = await signedInAs(ceo);
    const created = await client.post('/api/jobs/test').send({ shouldFail: true });
    expect(created.status).toBe(201);
    const stored = state.jobs.get(`integrations:${created.body.data.id}`);
    expect(stored.data).toEqual({ requestedBy: String(ceo._id), shouldFail: true });
  });

  it('lists failed jobs with pages, retries one and deletes one', async () => {
    const client = await signedInAs(ceo);
    for (let count = 0; count < 3; count += 1) {
      const { id } = await enqueue('messaging', 'send.message', { messageId: `m${count}` });
      failJob('messaging', id);
    }

    const list = await client.get('/api/jobs/failed?queue=messaging&pageSize=2');
    expect(list.status).toBe(200);
    expect(list.body.data).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(list.body.data.items).toHaveLength(2);
    expect(list.body.data.items[0]).toMatchObject({
      name: 'send.message',
      failedReason: 'provider timed out',
      attemptsMade: QUEUE_SETTINGS.messaging.attempts,
    });

    const retried = await client.post('/api/jobs/messaging/1/retry');
    expect(retried.status).toBe(200);
    expect(state.jobs.get('messaging:1').state).toBe('waiting');

    const removed = await client.delete('/api/jobs/messaging/2');
    expect(removed.status).toBe(200);
    expect(state.jobs.has('messaging:2')).toBe(false);

    const after = await client.get('/api/jobs/failed?queue=messaging');
    expect(after.body.data.total).toBe(1);
  });

  it('answers 404 for a job that is not failed or does not exist, and 400 for bad input', async () => {
    const client = await signedInAs(ceo);
    const { id } = await enqueue('ai', 'score.lead', { leadId: '1' });
    expect((await client.post(`/api/jobs/ai/${id}/retry`)).status).toBe(404); // waiting, not failed
    expect((await client.delete('/api/jobs/ai/999')).status).toBe(404);
    expect((await client.get('/api/jobs/failed?queue=emails')).status).toBe(400);
    expect((await client.get('/api/jobs/failed')).status).toBe(400);
    expect((await client.post('/api/jobs/ai/bad%20id/retry')).status).toBe(400);
  });

  it('with Redis down the page still answers and actions fail clearly', async () => {
    const client = await signedInAs(ceo);
    state.redisUp = false;

    const overview = await client.get('/api/jobs');
    expect(overview.status).toBe(200);
    expect(overview.body.data.redis).toBe('down');
    expect(overview.body.data.queues.every((queue) => queue.available === false)).toBe(true);

    const test = await client.post('/api/jobs/test').send({});
    expect(test.status).toBe(503);
    expect(test.body.error.code).toBe('QUEUE_UNAVAILABLE');
    expect((await client.get('/api/jobs/failed?queue=ai')).status).toBe(503);
  });
});
