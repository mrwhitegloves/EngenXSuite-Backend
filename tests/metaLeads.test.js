import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// The Meta settings exist only for this test file; they are set before the app reads them.
const APP_SECRET = 'test-meta-app-secret';
Object.assign(process.env, {
  META_APP_SECRET: APP_SECRET,
  META_VERIFY_TOKEN: 'test-verify-token',
  META_PAGE_ACCESS_TOKEN: 'test-page-token',
});

const { createApp } = await import('../app.js');
const { createSessionMiddleware } = await import('../middleware/session.js');
const { Account } = await import('../models/account.model.js');
const { Activity } = await import('../models/activity.model.js');
const { Contact } = await import('../models/contact.model.js');
const { InboundLead, LeadForm } = await import('../models/inboundLead.model.js');
const { Notification } = await import('../models/notification.model.js');
const { Opportunity } = await import('../models/opportunity.model.js');
const { Role } = await import('../models/role.model.js');
const { Task } = await import('../models/task.model.js');
const { User } = await import('../models/user.model.js');
const { WebhookEvent } = await import('../models/webhookEvent.model.js');
const { runSeed, seedStartingLists, seedStatusLists } = await import('../seeds/seed.js');
const { mapAnswers } = await import('../services/inboundLeads.service.js');
const { processWebhookEvent } = await import('../services/webhooks.service.js');
const { clearTestDb, startTestDbWithTransactions, stopTestDb } =
  await import('./helpers/testDb.js');

const PASSWORD = 'correct-horse-battery';
const FORM_ID = '700100';
let app;
let asCeo;
let asAgent;
let agents;

// What "Meta" knows: lead id → its answers. The Graph API is replaced by this.
const metaLeads = new Map();
let metaIsDown = false;
const graphCalls = [];
function fakeGraph(url, options) {
  const { pathname } = new URL(url);
  const id = pathname.split('/').pop();
  graphCalls.push({ id, authorization: options?.headers?.Authorization, url: String(url) });
  const answer = (status, body) => ({ ok: status === 200, status, json: async () => body });
  if (metaIsDown) return answer(400, { error: { message: 'Error validating access token' } });
  if (id === FORM_ID) return answer(200, { id, name: 'Factory OEE enquiry' });
  if (metaLeads.has(id)) return answer(200, metaLeads.get(id));
  return answer(404, { error: { message: 'Unsupported get request' } });
}

const lead = (id, answers, extra = {}) =>
  metaLeads.set(id, {
    id,
    created_time: '2026-10-10T06:00:00+0000',
    form_id: FORM_ID,
    campaign_name: 'Diwali OEE campaign',
    adset_name: 'Pune plant heads',
    ad_name: 'OEE video',
    field_data: Object.entries(answers).map(([name, value]) => ({ name, values: [value] })),
    ...extra,
  });

const webhookBody = (...leadIds) => ({
  object: 'page',
  entry: [
    {
      id: '900200',
      time: 1_760_000_000,
      changes: leadIds.map((leadgenId) => ({
        field: 'leadgen',
        value: { leadgen_id: leadgenId, form_id: FORM_ID, page_id: '900200' },
      })),
    },
  ],
});
const sign = (text) => `sha256=${createHmac('sha256', APP_SECRET).update(text).digest('hex')}`;
const postWebhook = (body, signature) => {
  const text = JSON.stringify(body);
  return request(app)
    .post('/api/webhooks/meta/leads')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signature ?? sign(text))
    .send(text);
};

/** Deliver leads like Meta does, then run the background job for the stored event. */
async function deliver(...leadIds) {
  const response = await postWebhook(webhookBody(...leadIds));
  expect(response.status).toBe(200);
  const event = await WebhookEvent.findOne({ provider: 'meta_leads' }).sort({ _id: -1 }).lean();
  return processWebhookEvent(event._id).catch((error) => error);
}

async function signedInAs(user) {
  const client = request.agent(app);
  const response = await client
    .post('/api/auth/login')
    .send({ email: user.email, password: PASSWORD });
  expect(response.status).toBe(200);
  return client;
}
const setRule = (body) => asCeo.patch('/api/settings/lead-assignment').send(body);
const ownerNameOf = async (name) => {
  const found = await Opportunity.findOne({ name: new RegExp(`^${name}`) }).lean();
  return found.ownerId ? (await User.findById(found.ownerId).lean()).name : null;
};

beforeAll(async () => {
  // Creating a lead uses a transaction.
  await startTestDbWithTransactions();
  app = createApp({ sessionMiddleware: createSessionMiddleware() });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await stopTestDb();
});

beforeEach(async () => {
  await clearTestDb();
  metaLeads.clear();
  graphCalls.length = 0;
  metaIsDown = false;
  vi.stubGlobal('fetch', vi.fn(fakeGraph));
  await runSeed({ productName: 'P', companyName: 'C', workspaceDomain: 'engenx.in' });
  await seedStatusLists();
  await seedStartingLists();
  const roles = Object.fromEntries((await Role.find()).map((role) => [role.name, role]));
  const makeUser = (email, name, roleName) =>
    User.create({ email, name, roleId: roles[roleName]._id, status: 'active', password: PASSWORD });
  const ceo = await makeUser('ceo@engenx.in', 'Kunal CEO', 'CEO');
  await makeUser('manager@engenx.in', 'Meera Manager', 'Sales Manager');
  // Three agents, created in this order (the turn order of the round robin).
  agents = [];
  for (const name of ['Asha', 'Bala', 'Chitra']) {
    agents.push(await makeUser(`${name.toLowerCase()}@engenx.in`, `${name} Agent`, 'Sales Agent'));
  }
  asCeo = await signedInAs(ceo);
  asAgent = await signedInAs(agents[0]);
});

describe('the webhook address', () => {
  it('answers Meta’s one-time check only with the right verify token', async () => {
    const check = (token) =>
      request(app).get(
        `/api/webhooks/meta/leads?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=1158201444`,
      );
    const right = await check('test-verify-token');
    expect(right.status).toBe(200);
    expect(right.text).toBe('1158201444');
    expect(right.headers['content-type']).toContain('text/plain');
    expect((await check('wrong')).status).toBe(403);
    expect((await request(app).get('/api/webhooks/meta/leads')).status).toBe(403);
  });

  it('accepts only what Meta signed, stores it once, and answers before any work is done', async () => {
    lead('111', { full_name: 'Ravi Kumar', phone_number: '9876543210' });
    const forged = await postWebhook(webhookBody('111'), 'sha256=' + '0'.repeat(64));
    expect(forged.status).toBe(401);
    expect((await postWebhook(webhookBody('111'), 'nonsense')).status).toBe(401);
    expect(await WebhookEvent.countDocuments({ signatureValid: true })).toBe(0);

    expect((await postWebhook(webhookBody('111'))).status).toBe(200);
    // Meta sends the same event again: accepted, not stored twice.
    expect((await postWebhook(webhookBody('111'))).status).toBe(200);
    expect(await WebhookEvent.countDocuments({ signatureValid: true })).toBe(1);
    // Nothing was fetched or created inside the request.
    expect(graphCalls).toEqual([]);
    expect(await Opportunity.countDocuments()).toBe(0);
  });
});

describe('a lead from a Meta form', () => {
  it('becomes a company, a person and a lead with an owner, a task and a notification', async () => {
    lead('111', {
      full_name: 'Ravi Kumar',
      phone_number: '+91 98765 43210',
      'Work E-mail': 'Ravi@KalyaniForge.com',
      company_name: 'Kalyani Forge',
      job_title: 'Plant Head',
      city: 'Pune',
      'How many machines do you have?': '40',
    });
    expect(await deliver('111')).toBe('processed');

    // The token goes to Meta in a header, never in the address.
    expect(graphCalls[0]).toMatchObject({ id: '111', authorization: 'Bearer test-page-token' });
    expect(graphCalls.every((call) => !call.url.includes('test-page-token'))).toBe(true);

    const inbound = await InboundLead.findOne({ externalId: '111' }).lean();
    expect(inbound).toMatchObject({
      source: 'meta_ads',
      status: 'processed',
      phone_number: '+919876543210',
      email: 'ravi@kalyaniforge.com',
      unmappedNote: 'How many machines do you have?: 40',
      campaign: { campaignName: 'Diwali OEE campaign', formName: 'Factory OEE enquiry' },
    });
    expect(inbound.mapped).toMatchObject({
      'contact.name': 'Ravi Kumar',
      'account.name': 'Kalyani Forge',
      'contact.designation': 'Plant Head',
      'account.hq.city': 'Pune',
    });

    const account = await Account.findById(inbound.accountId).lean();
    expect(account).toMatchObject({
      name: 'Kalyani Forge',
      accountCode: 'EGX-10001',
      source: 'meta_ads',
      hq: { city: 'Pune' },
      sourceDetail: {
        campaign: 'Diwali OEE campaign',
        ad: 'OEE video',
        form: 'Factory OEE enquiry',
      },
    });
    const contact = await Contact.findById(inbound.contactId).lean();
    expect(contact).toMatchObject({
      name: 'Ravi Kumar',
      designation: 'Plant Head',
      phone_number: '+919876543210',
      email: 'ravi@kalyaniforge.com',
      source: 'meta_ads',
    });
    const made = await Opportunity.findById(inbound.opportunityId).lean();
    expect(made).toMatchObject({
      leadCode: 'EGL-10001',
      name: 'Ravi Kumar · Factory OEE enquiry',
      source: 'meta_ads',
      status: 'open',
      sourceDetail: { campaign: 'Diwali OEE campaign' },
    });
    expect(String(made.leadId)).toBe(String(inbound._id));
    expect(String(made.primaryContactId)).toBe(String(contact._id));
    // Round robin: the first agent. The company and the person are theirs too.
    expect(String(made.ownerId)).toBe(String(agents[0]._id));
    expect(String(account.ownerId)).toBe(String(agents[0]._id));
    expect(String(contact.ownerId)).toBe(String(agents[0]._id));
    // Nobody typed these: no "form filled by", no "created by".
    expect(made.formFilledBy).toBeUndefined();
    expect(account.createdBy).toBeUndefined();

    const timeline = await Activity.find({ opportunityId: made._id }).sort({ _id: 1 }).lean();
    expect(timeline.map((entry) => [entry.type, entry.subtype])).toEqual([
      ['SYSTEM', 'lead_created'],
      ['SYSTEM', 'lead_received'],
      ['NOTE', 'form_answers'],
      ['TASK', 'task_created'],
    ]);
    expect(timeline[2].content).toBe('How many machines do you have?: 40');

    const tasks = await Task.find().lean();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      title: 'Call the new lead: Ravi Kumar',
      type: 'follow_up',
      priority: 'high',
      source: 'lead',
    });
    expect(String(tasks[0].assigneeId)).toBe(String(agents[0]._id));
    const notifications = await Notification.find().lean();
    expect(notifications.map((item) => [item.type, item.title, item.body])).toEqual([
      ['lead_received', 'New lead: Ravi Kumar', 'Meta ads · Factory OEE enquiry'],
    ]);

    // The agent sees it in their pipeline like any other lead.
    const mine = (await asAgent.get('/api/opportunities')).body.data;
    expect(mine.map((item) => item.name)).toEqual(['Ravi Kumar · Factory OEE enquiry']);
  });

  it('is never created twice, however often the event or the job comes again', async () => {
    lead('111', { full_name: 'Ravi Kumar', phone_number: '9876543210' });
    await deliver('111');
    const event = await WebhookEvent.findOne().lean();
    expect(await processWebhookEvent(event._id)).toBe('processed');
    // A different event (another body) naming the same lead.
    await deliver('111', '111');
    expect(await InboundLead.countDocuments()).toBe(1);
    expect(await Opportunity.countDocuments()).toBe(1);
    expect(await Account.countDocuments()).toBe(1);
    expect(await Contact.countDocuments()).toBe(1);
    expect(await Task.countDocuments()).toBe(1);
    expect(await Notification.countDocuments()).toBe(1);
  });

  it('one bad answer does not lose the lead; someone without a company gets one of their own name', async () => {
    lead('111', { full_name: 'Sunita Rao', phone_number: '12345', email: 'not-an-email' });
    expect(await deliver('111')).toBe('processed');
    const contact = await Contact.findOne({ name: 'Sunita Rao' }).lean();
    expect(contact.phone_number).toBeUndefined();
    expect(contact.email).toBeUndefined();
    expect((await Account.findById(contact.accountId).lean()).name).toBe('Sunita Rao');
    const inbound = await InboundLead.findOne().lean();
    expect(inbound.unmappedNote).toContain('phone_number (as typed): "12345"');
    expect(inbound.unmappedNote).toContain('email (as typed): "not-an-email"');
  });

  it('a second person of a company that is already there joins that company', async () => {
    lead('111', {
      full_name: 'Ravi Kumar',
      phone_number: '9876543210',
      company_name: 'Kalyani Forge',
    });
    await deliver('111');
    // The first lead is closed, so the next enquiry is new business, not a repeat.
    await Opportunity.updateMany({}, { $set: { status: 'lost' } });
    lead('222', {
      full_name: 'Neha Shah',
      phone_number: '9123456780',
      company_name: 'KALYANI FORGE LTD',
    });
    await deliver('222');
    expect(await Account.countDocuments()).toBe(1);
    expect(await Contact.countDocuments()).toBe(2);
    expect(await Opportunity.countDocuments()).toBe(2);
  });

  it('the same person enquiring again is noted on their open lead, not made a new one', async () => {
    lead('111', { full_name: 'Ravi Kumar', phone_number: '9876543210' });
    await deliver('111');
    lead('222', {
      full_name: 'Ravi K',
      phone_number: '09876543210',
      'What do you need?': 'Price list',
    });
    expect(await deliver('222')).toBe('processed');

    expect(await Opportunity.countDocuments()).toBe(1);
    expect(await Contact.countDocuments()).toBe(1);
    const [first, second] = await InboundLead.find().sort({ _id: 1 }).lean();
    expect(second).toMatchObject({ status: 'duplicate' });
    expect(String(second.opportunityId)).toBe(String(first.opportunityId));
    expect(first).toMatchObject({ duplicateCount: 1 });
    expect(first.repeatEnquiries[0]).toMatchObject({
      externalId: '222',
      formName: 'Factory OEE enquiry',
    });

    const again = await Activity.findOne({ subtype: 'lead_enquired_again' }).lean();
    expect(again).toMatchObject({
      title: 'Enquired again through Meta ads: Factory OEE enquiry',
      content: 'What do you need?: Price list',
    });
    expect((await Notification.find().sort({ _id: 1 }).lean()).map((item) => item.title)).toEqual([
      'New lead: Ravi Kumar',
      'Enquired again: Ravi Kumar',
    ]);
    // Still one first task.
    expect(await Task.countDocuments()).toBe(1);
  });
});

describe('who gets the lead', () => {
  const three = async () => {
    for (const [index, id] of ['111', '222', '333'].entries()) {
      lead(id, { full_name: `Person ${index + 1}`, phone_number: `987654321${index}` });
      await deliver(id);
    }
    return Promise.all([1, 2, 3].map((number) => ownerNameOf(`Person ${number}`)));
  };

  it('round robin over all sales agents is the default; someone who is away is skipped', async () => {
    const rule = (await asCeo.get('/api/settings/lead-assignment')).body.data;
    expect(rule.mode).toBe('round_robin_all');
    expect(rule.users.filter((user) => user.isAgent).map((user) => user.name)).toEqual([
      'Asha Agent',
      'Bala Agent',
      'Chitra Agent',
    ]);
    await setRule({ awayUserIds: [String(agents[1]._id)] });
    expect(await three()).toEqual(['Asha Agent', 'Chitra Agent', 'Asha Agent']);
  });

  it('round robin over chosen people, and always the same person', async () => {
    await setRule({
      mode: 'round_robin_selected',
      userIds: [String(agents[2]._id), String(agents[1]._id)],
    });
    expect(await three()).toEqual(['Bala Agent', 'Chitra Agent', 'Bala Agent']);

    await setRule({ mode: 'fixed', fixedUserId: String(agents[2]._id) });
    lead('444', { full_name: 'Person 4', phone_number: '9876543214' });
    await deliver('444');
    expect(await ownerNameOf('Person 4')).toBe('Chitra Agent');
  });

  it('the person with the fewest open leads', async () => {
    await setRule({ mode: 'least_open' });
    expect(await three()).toEqual(['Asha Agent', 'Bala Agent', 'Chitra Agent']);
    // Bala closes theirs: the next lead goes to Bala.
    await Opportunity.updateMany({ ownerId: agents[1]._id }, { $set: { status: 'won' } });
    lead('444', { full_name: 'Person 4', phone_number: '9876543214' });
    await deliver('444');
    expect(await ownerNameOf('Person 4')).toBe('Bala Agent');
  });

  it('switched off: the lead and its company stay unassigned, with no task and no notification', async () => {
    await setRule({ mode: 'off' });
    lead('111', { full_name: 'Nobody Yet', phone_number: '9876543210' });
    expect(await deliver('111')).toBe('processed');
    const made = await Opportunity.findOne().lean();
    expect(made.ownerId).toBeNull();
    expect((await Account.findOne().lean()).ownerId).toBeUndefined();
    expect(await Task.countDocuments()).toBe(0);
    expect(await Notification.countDocuments()).toBe(0);
    // The CEO finds it under "unassigned"; an agent does not see it at all.
    const unassigned = (await asCeo.get('/api/opportunities?ownerId=unassigned')).body.data;
    expect(unassigned).toHaveLength(1);
    expect((await asAgent.get('/api/opportunities')).body.data).toEqual([]);
    // The company without an owner is listed for the CEO, and opens.
    const companies = (await asCeo.get('/api/accounts')).body.data;
    expect(companies[0]).toMatchObject({ name: 'Nobody Yet', owner: null });
    expect((await asCeo.get(`/api/accounts/${companies[0].id}`)).status).toBe(200);
  });

  it('a form’s own owner comes before the rule; the rule is checked when it is saved', async () => {
    lead('111', { full_name: 'Person 1', phone_number: '9876543210' });
    await deliver('111');
    const form = (await asCeo.get('/api/lead-forms')).body.data.forms[0];
    await asCeo.patch(`/api/lead-forms/${form.id}`).send({ defaultOwnerId: String(agents[2]._id) });
    lead('222', { full_name: 'Person 2', phone_number: '9876543211' });
    await deliver('222');
    expect(await ownerNameOf('Person 2')).toBe('Chitra Agent');

    expect((await setRule({ mode: 'fixed' })).status).toBe(400);
    expect((await setRule({ mode: 'round_robin_selected', userIds: [] })).status).toBe(400);
    expect((await setRule({ mode: 'nonsense' })).status).toBe(400);
    expect((await setRule({ userIds: ['0123456789abcdef01234567'] })).status).toBe(400);
    // Settings are for people who manage them.
    expect((await asAgent.get('/api/settings/lead-assignment')).status).toBe(403);
    expect(
      (await asAgent.patch('/api/settings/lead-assignment').send({ mode: 'off' })).status,
    ).toBe(403);
    expect((await asAgent.get('/api/lead-forms')).status).toBe(403);
    expect((await asAgent.get('/api/inbound-leads')).status).toBe(403);
  });
});

describe('lead forms and failed leads', () => {
  it('maps answers by name where that is clear, and by the form’s own mapping', () => {
    const answers = [
      { name: 'first_name', value: 'Ravi' },
      { name: 'last_name', value: 'Kumar' },
      { name: 'WhatsApp Number', value: '98765 43210' },
      { name: 'Which plant?', value: 'Chakan' },
      { name: 'Budget', value: '10 lakh' },
      { name: 'Favourite colour', value: 'Red' },
    ];
    const result = mapAnswers(answers, [
      { question: 'Which plant?', crmField: 'account.hq.city' },
      { question: 'Favourite colour', crmField: 'ignore' },
    ]);
    expect(result.mapped).toEqual({
      'contact.name': 'Ravi Kumar',
      'contact.phone_number': '+919876543210',
      'account.hq.city': 'Chakan',
    });
    expect(result.notes).toEqual(['Budget: 10 lakh']);
  });

  it('the Lead forms screen lists the forms and their questions, and saves a mapping', async () => {
    lead('111', {
      full_name: 'Ravi Kumar',
      phone_number: '9876543210',
      'Your plant city': 'Chakan',
    });
    await deliver('111');
    const page = (await asCeo.get('/api/lead-forms')).body.data;
    expect(page.setup).toEqual({
      isConfigured: true,
      missing: [],
      webhookPath: '/api/webhooks/meta/leads',
    });
    expect(page.forms).toHaveLength(1);
    expect(page.forms[0]).toMatchObject({ name: 'Factory OEE enquiry', isActive: true });
    expect(page.forms[0].questions).toEqual([
      { question: 'full_name', crmField: '', automatic: true },
      { question: 'phone_number', crmField: '', automatic: true },
      { question: 'Your plant city', crmField: '', automatic: false },
    ]);

    const saved = await asCeo.patch(`/api/lead-forms/${page.forms[0].id}`).send({
      fieldMapping: [{ question: 'Your plant city', crmField: 'account.hq.city' }],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data.questions[2]).toMatchObject({ crmField: 'account.hq.city' });
    expect(
      (
        await asCeo.patch(`/api/lead-forms/${page.forms[0].id}`).send({
          fieldMapping: [{ question: 'x', crmField: 'ownerId' }],
        })
      ).status,
    ).toBe(400);

    lead('222', {
      full_name: 'Neha Shah',
      phone_number: '9123456780',
      'Your plant city': 'Nashik',
    });
    await deliver('222');
    expect((await Account.findOne({ name: 'Neha Shah' }).lean()).hq.city).toBe('Nashik');

    // A switched-off form: the enquiry is stored, nothing is created.
    await asCeo.patch(`/api/lead-forms/${page.forms[0].id}`).send({ isActive: false });
    lead('333', { full_name: 'Stored Only', phone_number: '9000000001' });
    await deliver('333');
    expect(await Opportunity.countDocuments()).toBe(2);
    expect((await InboundLead.findOne({ externalId: '333' }).lean()).status).toBe('processed');
    expect(await LeadForm.countDocuments()).toBe(1);
  });

  it('a lead that fails is listed with its reason and can be tried again', async () => {
    lead('111', { full_name: 'Ravi Kumar', phone_number: '9876543210' });
    metaIsDown = true;
    const outcome = await deliver('111');
    expect(outcome).toBeInstanceOf(Error);
    expect((await WebhookEvent.findOne().lean()).status).toBe('failed');

    const failed = (await asCeo.get('/api/inbound-leads?status=failed')).body.data;
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      status: 'failed',
      error: 'Meta refused the request: Error validating access token',
    });
    expect(await Opportunity.countDocuments()).toBe(0);

    // The token is fixed: the retry goes through, and a second retry is refused.
    metaIsDown = false;
    const retried = await asCeo.post(`/api/inbound-leads/${failed[0].id}/retry`);
    expect(retried.status).toBe(200);
    expect(retried.body.data.status).toBe('processed');
    expect(await Opportunity.countDocuments()).toBe(1);
    expect((await asCeo.post(`/api/inbound-leads/${failed[0].id}/retry`)).status).toBe(409);
    const all = (await asCeo.get('/api/inbound-leads')).body.data;
    expect(all[0]).toMatchObject({ status: 'processed', name: 'Ravi Kumar', error: null });
  });
});
