import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// The key exists only for this test file; no request ever leaves the computer: `fetch` is
// replaced below, and it answers what each test puts in `answers`.
process.env.OPENROUTER_API_KEY = 'test-openrouter-key';

const sent = [];
let answers = [];
const reply = (
  content,
  { cost = 0.001, status = 200, model = 'anthropic/claude-haiku-5.5' } = {},
) => ({
  status,
  body:
    status === 200
      ? {
          model,
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 120, completion_tokens: 40, cost },
        }
      : { error: { message: content } },
});
vi.stubGlobal('fetch', async (url, options) => {
  sent.push({ url, headers: options.headers, body: JSON.parse(options.body) });
  const next = answers.shift();
  if (!next) throw new Error('No answer prepared for this model call');
  return new Response(JSON.stringify(next.body), { status: next.status });
});

const { redact } = await import('../ai/redact.js');
const { runAiTask } = await import('../ai/runTask.js');
const { AiRun } = await import('../models/aiRun.model.js');
const { AiUsageDaily, AiUsageMonthly } = await import('../models/aiUsage.model.js');
const { Notification } = await import('../models/notification.model.js');
const { Role } = await import('../models/role.model.js');
const { Settings } = await import('../models/settings.model.js');
const { User } = await import('../models/user.model.js');
const { runSeed } = await import('../seeds/seed.js');
const { clearTestDb, startTestDb, stopTestDb } = await import('./helpers/testDb.js');

let ceo;
let agent;
const schema = z.object({ summary: z.string().min(1), risk: z.enum(['low', 'medium', 'high']) });
const good = JSON.stringify({ summary: 'A steel maker with two plants.', risk: 'low' });
const task = (extra = {}) => ({
  task: 'summarizeAccount',
  promptVersion: 'summarizeAccount/v1',
  system: 'Summarise the company. Answer with JSON: { summary, risk }.',
  user: 'Company: Bharat Forge. Notes: asked for a pilot.',
  schema,
  userId: agent._id,
  entityType: 'accounts',
  ...extra,
});

beforeAll(startTestDb);
afterAll(stopTestDb);
beforeEach(async () => {
  await clearTestDb();
  sent.length = 0;
  answers = [];
  await runSeed({ productName: 'P', companyName: 'C', workspaceDomain: 'engenx.in' });
  const roles = Object.fromEntries((await Role.find()).map((role) => [role.name, role]));
  const makeUser = (email, roleName) =>
    User.create({
      email,
      name: email,
      roleId: roles[roleName]._id,
      status: 'active',
      password: 'correct-horse',
    });
  ceo = await makeUser('ceo@engenx.in', 'CEO');
  agent = await makeUser('agent@engenx.in', 'Sales Agent');
});

describe('runAiTask', () => {
  it('asks the model once, gives back the validated answer, and writes the run and its cost', async () => {
    answers = [reply(good, { cost: 0.002 })];
    const result = await runAiTask(task());
    expect(result.output).toEqual({ summary: 'A steel maker with two plants.', risk: 'low' });

    // What was sent: our key, the model with its fallback, JSON asked for, no data kept.
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(sent[0].headers.Authorization).toBe('Bearer test-openrouter-key');
    expect(sent[0].body).toMatchObject({
      models: ['anthropic/claude-haiku-5.5', 'google/gemini-3.8-flash'],
      response_format: { type: 'json_object' },
      provider: { data_collection: 'deny' },
    });

    const run = await AiRun.findById(result.runId).lean();
    expect(run).toMatchObject({
      task: 'summarizeAccount',
      promptVersion: 'summarizeAccount/v1',
      model: 'anthropic/claude-haiku-5.5',
      status: 'success',
      output: { risk: 'low' },
      promptTokens: 120,
      completionTokens: 40,
      costMicroUsd: 2000,
      costPaise: 18, // 0.002 dollars at 90 rupees
      entityType: 'accounts',
    });
    expect(String(run.userId)).toBe(String(agent._id));
    const month = await AiUsageMonthly.findOne().lean();
    expect(month).toMatchObject({ totalCostPaise: 18, runs: 1, capPaise: 200000 });
    expect(month.byTask.summarizeAccount).toEqual({ costPaise: 18, runs: 1 });
    expect((await AiUsageDaily.findOne({ userId: agent._id }).lean()).count).toBe(1);
  });

  it('never sends tax ids, bank details or secrets to the model', async () => {
    answers = [reply(good)];
    await runAiTask(
      task({
        user: 'GSTIN 27AAPFU0939F1ZV, PAN AAPFU0939F. Bank account no. 123456789012, IFSC HDFC0001234. Token sk-live_abcdefghijklmnop123. password: hunter2secret. Call Asha on +91 98765 43210.',
      }),
    );
    const prompt = sent[0].body.messages[1].content;
    for (const secret of [
      '27AAPFU0939F1ZV',
      'AAPFU0939F',
      '123456789012',
      'HDFC0001234',
      'abcdefghijklmnop123',
      'hunter2secret',
    ]) {
      expect(prompt, secret).not.toContain(secret);
    }
    // What the task needs stays.
    expect(prompt).toContain('Call Asha on +91 98765 43210');
    expect(redact('Order 4521 for 12 sensors, due 14 Nov 2026')).toBe(
      'Order 4521 for 12 sensors, due 14 Nov 2026',
    );
  });

  it('an answer that does not fit is asked for once more, with the reason', async () => {
    answers = [reply('{"summary":"Short","risk":"enormous"}'), reply('```json\n' + good + '\n```')];
    const result = await runAiTask(task());
    expect(result.output.risk).toBe('low');
    expect(sent).toHaveLength(2);
    expect(sent[1].body.messages[1].content).toContain('Your last answer could not be used: risk');
    const runs = await AiRun.find().sort({ _id: 1 }).lean();
    expect(runs.map((run) => run.status)).toEqual(['invalid_output', 'success']);
    expect(String(runs[1].retryOf)).toBe(String(runs[0]._id));
    // Both calls cost money.
    expect((await AiUsageMonthly.findOne().lean()).runs).toBe(2);
  });

  it('two answers that do not fit: it fails as a whole, with nothing half-filled', async () => {
    answers = [reply('I think the company is fine.'), reply('{"summary":""}')];
    await expect(runAiTask(task())).rejects.toMatchObject({
      status: 502,
      code: 'AI_INVALID_OUTPUT',
      message: 'The AI could not process this. Try again.',
    });
    expect(sent).toHaveLength(2);
    const runs = await AiRun.find().sort({ _id: 1 }).lean();
    expect(runs.map((run) => run.status)).toEqual(['invalid_output', 'invalid_output']);
    expect(runs[0].output).toBe('I think the company is fine.');
    expect(runs[0].error).toBe('The answer was not valid JSON.');
  });

  it('a refusal by the AI service is passed on and written down', async () => {
    answers = [reply('Insufficient credits', { status: 402 })];
    await expect(runAiTask(task())).rejects.toMatchObject({
      status: 502,
      code: 'AI_PROVIDER_ERROR',
      message: 'The AI service refused the request: Insufficient credits',
    });
    expect(await AiRun.findOne().lean()).toMatchObject({ status: 'failed' });
    expect(await AiUsageMonthly.countDocuments()).toBe(0);
  });
});

describe('the AI limits', () => {
  it('tells the CEO at 80% and at 100% of the monthly cap, once each, and then refuses', async () => {
    await Settings.updateOne({ key: 'app' }, { $set: { 'ai.monthlyCapPaise': 1000 } }); // ₹10
    // Each run costs 0.05 dollars = 450 paise: 45%, 90%, then 135%.
    answers = [
      reply(good, { cost: 0.05 }),
      reply(good, { cost: 0.05 }),
      reply(good, { cost: 0.05 }),
    ];
    await runAiTask(task());
    expect(await Notification.countDocuments()).toBe(0);
    await runAiTask(task());
    const first = await Notification.find().lean();
    expect(first.map((item) => [String(item.userId), item.type, item.title])).toEqual([
      [String(ceo._id), 'ai_budget', 'The AI budget for this month is 80% used'],
    ]);
    await runAiTask(task()); // still under the cap when it started
    expect((await Notification.find().sort({ _id: -1 }).lean())[0].title).toBe(
      'The AI budget for this month is used up',
    );
    expect(await Notification.countDocuments()).toBe(2);

    // The cap is reached: no model call is made, and the person is told why.
    await expect(runAiTask(task())).rejects.toMatchObject({
      status: 429,
      message: 'The AI budget for this month is used up. It starts again next month.',
    });
    expect(sent).toHaveLength(3);
    expect(await AiRun.countDocuments({ status: 'blocked_cap' })).toBe(1);
    expect(await Notification.countDocuments()).toBe(2);
  });

  it('one person has a number of runs per day; the system’s own runs are not counted to anyone', async () => {
    await Settings.updateOne({ key: 'app' }, { $set: { 'ai.dailyRunsPerUser': 2 } });
    answers = [reply(good), reply(good), reply(good)];
    await runAiTask(task());
    await runAiTask(task());
    await expect(runAiTask(task())).rejects.toMatchObject({
      status: 429,
      message: 'You have used all your AI requests for today. Try again tomorrow.',
    });
    expect(await AiRun.countDocuments({ status: 'blocked_limit' })).toBe(1);
    // Someone else, and a run without a person, still work.
    await runAiTask(task({ userId: undefined }));
    expect(sent).toHaveLength(3);
  });
});

describe('the rule: only server/ai talks to a model', () => {
  it('no file outside server/ai imports the model client or names the provider', () => {
    const root = path.resolve(import.meta.dirname, '..');
    const skip = new Set(['node_modules', 'tests', 'coverage', '.git', 'ai', 'public']);
    const offenders = [];
    const walk = (directory) => {
      for (const name of readdirSync(directory)) {
        const full = path.join(directory, name);
        if (statSync(full).isDirectory()) {
          if (!skip.has(name)) walk(full);
        } else if (name.endsWith('.js')) {
          const text = readFileSync(full, 'utf8');
          if (/ai\/client\.js|openrouter\.ai/.test(text)) offenders.push(path.relative(root, full));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
