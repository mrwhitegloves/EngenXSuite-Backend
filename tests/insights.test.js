import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// The key exists only for this test file; no request ever leaves the computer: `fetch` is
// replaced below, and it answers what each test puts in `answers`.
process.env.OPENROUTER_API_KEY = 'test-openrouter-key';

const sent = [];
let answers = [];
vi.stubGlobal('fetch', async (url, options) => {
  sent.push(JSON.parse(options.body));
  const content = answers.shift();
  if (!content) throw new Error('No answer prepared for this model call');
  return new Response(
    JSON.stringify({
      model: sent.at(-1).models[0],
      choices: [{ message: { content: JSON.stringify(content) } }],
      usage: { prompt_tokens: 500, completion_tokens: 150, cost: 0.001 },
    }),
    { status: 200 },
  );
});

const { createApp } = await import('../app.js');
const { createSessionMiddleware } = await import('../middleware/session.js');
const { AiInsight } = await import('../models/aiInsight.model.js');
const { AiRun } = await import('../models/aiRun.model.js');
const { AuditLog } = await import('../models/auditLog.model.js');
const { Opportunity } = await import('../models/opportunity.model.js');
const { Role } = await import('../models/role.model.js');
const { User } = await import('../models/user.model.js');
const { runSeed, seedStartingLists, seedStatusLists } = await import('../seeds/seed.js');
const { clearTestDb, startTestDbWithTransactions, stopTestDb } =
  await import('./helpers/testDb.js');

const PASSWORD = 'correct-horse-battery';
let app;
let asCeo;
let asAgent;
let asOther;
let accountId;
let leadId;

const SUMMARY = {
  summary: 'Bharat Forge makes forgings in Pune. One open lead for OEE on the press line.',
  keyPoints: ['Asked for a pilot on two presses'],
  opportunities: ['OEE monitoring for the press line'],
  risks: [],
  missingInformation: ['Who signs the purchase order'],
};
const ASSESSMENT = {
  score: 62,
  positives: ['A clear requirement'],
  concerns: ['No budget named yet'],
  riskLevel: 'medium',
  nextBestAction: {
    action: 'Call Asha Verma to ask about the budget',
    reason: 'Budget is unknown',
  },
  missingInformation: ['Budget'],
};

async function signedInAs(user) {
  const client = request.agent(app);
  const response = await client
    .post('/api/auth/login')
    .send({ email: user.email, password: PASSWORD });
  expect(response.status).toBe(200);
  return client;
}

beforeAll(async () => {
  await startTestDbWithTransactions(); // creating a lead uses a transaction
  app = createApp({ sessionMiddleware: createSessionMiddleware() });
});
afterAll(stopTestDb);

beforeEach(async () => {
  await clearTestDb();
  sent.length = 0;
  answers = [];
  await runSeed({ productName: 'P', companyName: 'C', workspaceDomain: 'engenx.in' });
  await seedStatusLists();
  await seedStartingLists();
  const roles = Object.fromEntries((await Role.find()).map((role) => [role.name, role]));
  const makeUser = (email, name, roleName) =>
    User.create({ email, name, roleId: roles[roleName]._id, status: 'active', password: PASSWORD });
  const ceo = await makeUser('ceo@engenx.in', 'Kunal CEO', 'CEO');
  const agent = await makeUser('agent@engenx.in', 'Asha Agent', 'Sales Agent');
  const other = await makeUser('other@engenx.in', 'Omar Agent', 'Sales Agent');
  [asCeo, asAgent, asOther] = await Promise.all([ceo, agent, other].map(signedInAs));

  const created = await asAgent.post('/api/accounts/quick-add').send({
    account: { name: 'Bharat Forge', industry: 'Forgings', gstin: '27AAPFU0939F1ZV' },
    contacts: [{ name: 'Asha Verma', designation: 'Plant Head', phone_number: '98765 43210' }],
    lead: { name: 'OEE for press line', requirement: 'Pilot on two presses' },
  });
  expect(created.status).toBe(201);
  accountId = created.body.data.account.id;
  leadId = created.body.data.lead.id;
  await asAgent
    .post('/api/notes')
    .send({ opportunityId: leadId, content: 'They want a pilot first.' });
});

describe('the AI summary of a company', () => {
  it('is made from the company’s records, kept, and shown again without a new model call', async () => {
    const empty = await asAgent.get(`/api/insights/accounts/${accountId}`);
    expect(empty.body.data).toEqual({ isAiReady: true, insight: null });

    answers = [SUMMARY];
    const made = await asAgent.post(`/api/insights/accounts/${accountId}/refresh`);
    expect(made.status).toBe(200);
    expect(made.body.data.insight).toMatchObject({
      content: SUMMARY,
      model: 'anthropic/claude-haiku-5.5',
      generatedBy: 'Asha Agent',
    });

    // What the model was shown: the records, and no tax id or phone number.
    const prompt = sent[0].messages[1].content;
    const context = JSON.parse(prompt);
    expect(context.company).toMatchObject({ name: 'Bharat Forge', industry: 'Forgings' });
    expect(context.people[0]).toMatchObject({ name: 'Asha Verma', designation: 'Plant Head' });
    expect(context.leads[0]).toMatchObject({ name: 'OEE for press line', status: 'open' });
    expect(context.recentHistory.some((entry) => entry.text === 'They want a pilot first.')).toBe(
      true,
    );
    expect(prompt).not.toContain('27AAPFU0939F1ZV');
    expect(prompt).not.toContain('9876543210');

    const again = await asAgent.get(`/api/insights/accounts/${accountId}`);
    expect(again.body.data.insight.content).toEqual(SUMMARY);
    expect(sent).toHaveLength(1);
    expect(await AiRun.findOne().lean()).toMatchObject({
      task: 'summarizeAccount',
      promptVersion: 'summarizeAccount/v1',
      status: 'success',
      entityType: 'accounts',
    });
  });

  it('someone who may not see the company gets "not found", and nobody without a sign-in', async () => {
    expect((await asOther.get(`/api/insights/accounts/${accountId}`)).status).toBe(404);
    expect((await asOther.post(`/api/insights/accounts/${accountId}/refresh`)).status).toBe(404);
    expect((await request(app).get(`/api/insights/accounts/${accountId}`)).status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it('a summary built from leads someone may not see is not shown to them', async () => {
    // The CEO adds a second lead on the same company, which the agent may not see.
    const hidden = await asCeo
      .post('/api/opportunities')
      .send({ name: 'Secret expansion', accountId });
    expect(hidden.status).toBe(201);
    answers = [{ ...SUMMARY, summary: 'Includes the secret expansion.' }];
    await asCeo.post(`/api/insights/accounts/${accountId}/refresh`);
    expect(JSON.parse(sent[0].messages[1].content).leads).toHaveLength(2);

    // The agent sees no summary yet; theirs is made only from what they may see.
    expect((await asAgent.get(`/api/insights/accounts/${accountId}`)).body.data.insight).toBeNull();
    answers = [SUMMARY];
    await asAgent.post(`/api/insights/accounts/${accountId}/refresh`);
    const shown = JSON.parse(sent[1].messages[1].content);
    expect(shown.leads.map((lead) => lead.name)).toEqual(['OEE for press line']);
    // Each keeps their own.
    expect(
      (await asCeo.get(`/api/insights/accounts/${accountId}`)).body.data.insight.content.summary,
    ).toBe('Includes the secret expansion.');
    expect(await AiInsight.countDocuments()).toBe(2);
  });
});

describe('the AI score and next best action of a lead', () => {
  it('is made from the lead’s records, kept, and copied onto the lead as score and risk', async () => {
    answers = [ASSESSMENT];
    const made = await asAgent.post(`/api/insights/leads/${leadId}/refresh`);
    expect(made.status).toBe(200);
    expect(made.body.data.insight.content).toEqual(ASSESSMENT);
    const context = JSON.parse(sent[0].messages[1].content);
    expect(context.lead).toMatchObject({
      name: 'OEE for press line',
      requirement: 'Pilot on two presses',
    });
    expect(context.mainContact).toMatchObject({ name: 'Asha Verma' });
    expect(context.history.length).toBeGreaterThan(0);

    const lead = await Opportunity.findById(leadId).lean();
    expect(lead).toMatchObject({ aiScore: 62, aiRiskLevel: 'medium' });
    expect(
      (await asAgent.get(`/api/insights/leads/${leadId}`)).body.data.insight.content.score,
    ).toBe(62);
    expect(sent).toHaveLength(1);
  });

  it('follows the lead access rule, and an answer with a price or a stage in it is not possible', async () => {
    expect((await asOther.get(`/api/insights/leads/${leadId}`)).status).toBe(404);
    expect((await asOther.post(`/api/insights/leads/${leadId}/refresh`)).status).toBe(404);

    // The model adds fields it must not: they are dropped, never kept.
    answers = [{ ...ASSESSMENT, newStage: 'Won', discountPercent: 20, ownerId: 'someone' }];
    const made = await asAgent.post(`/api/insights/leads/${leadId}/refresh`);
    expect(Object.keys(made.body.data.insight.content).sort()).toEqual(
      Object.keys(ASSESSMENT).sort(),
    );
    const before = await Opportunity.findById(leadId).lean();
    expect(before.status).toBe('open');
  });

  it('a wrong answer twice gives a clear error and keeps nothing', async () => {
    answers = [{ score: 'high' }, { score: 400 }];
    const failed = await asAgent.post(`/api/insights/leads/${leadId}/refresh`);
    expect(failed.status).toBe(502);
    expect(failed.body.error.message).toBe('The AI could not process this. Try again.');
    expect(await AiInsight.countDocuments()).toBe(0);
    expect((await Opportunity.findById(leadId).lean()).aiScore).toBeUndefined();
  });
});

describe('Settings → AI', () => {
  it('shows the limits, the models and this month’s spending; the CEO changes them', async () => {
    answers = [SUMMARY];
    await asAgent.post(`/api/insights/accounts/${accountId}/refresh`);
    const view = (await asCeo.get('/api/settings/ai')).body.data;
    expect(view).toMatchObject({
      isAiReady: true,
      monthlyCapPaise: 200000,
      dailyRunsPerUser: 100,
      alertPercent: 80,
      usage: {
        totalCostPaise: 9,
        runs: 1,
        byTask: [{ task: 'summarizeAccount', costPaise: 9, runs: 1 }],
      },
    });
    expect(view.classes.map((item) => [item.key, item.model, item.fallback])).toEqual([
      ['fast', 'anthropic/claude-haiku-5.5', 'google/gemini-3.1-flash-lite'],
      ['balanced', 'anthropic/claude-haiku-5.5', 'google/gemini-3.8-flash'],
      ['strong', 'anthropic/claude-sonnet-5.5', 'openai/gpt-5.4'],
    ]);
    expect(new Set(view.choices.map((choice) => choice.provider))).toEqual(
      new Set(['Anthropic', 'Google', 'OpenAI']),
    );

    const saved = await asCeo.patch('/api/settings/ai').send({
      monthlyCapPaise: 500000,
      dailyRunsPerUser: 40,
      alertPercent: 70,
      models: { balanced: { model: 'openai/gpt-5.4-mini', fallback: null } },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({
      monthlyCapPaise: 500000,
      dailyRunsPerUser: 40,
      alertPercent: 70,
    });
    expect(await AuditLog.countDocuments({ action: 'settings.ai_updated' })).toBe(1);

    // The next run of that class uses the chosen model, with no second choice.
    answers = [SUMMARY];
    await asAgent.post(`/api/insights/accounts/${accountId}/refresh`);
    expect(sent.at(-1).models).toEqual(['openai/gpt-5.4-mini']);
  });

  it('refuses a model that is not on the list, the same model twice, and other people', async () => {
    const patch = (body) => asCeo.patch('/api/settings/ai').send(body);
    expect(
      (await patch({ models: { fast: { model: 'someone/unknown-model', fallback: null } } }))
        .status,
    ).toBe(400);
    const same = { model: 'openai/gpt-5.4', fallback: 'openai/gpt-5.4' };
    expect((await patch({ models: { strong: same } })).status).toBe(400);
    expect((await patch({ alertPercent: 150 })).status).toBe(400);
    expect((await patch({ monthlyCapPaise: 5 })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect((await asAgent.get('/api/settings/ai')).status).toBe(403);
    expect((await asAgent.patch('/api/settings/ai').send({ dailyRunsPerUser: 999 })).status).toBe(
      403,
    );
  });
});
