import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { createSessionMiddleware } from '../middleware/session.js';
import { AuditLog } from '../models/auditLog.model.js';
import { Opportunity, StageHistory } from '../models/opportunity.model.js';
import { PipelineStage } from '../models/pipelineStage.model.js';
import { Role } from '../models/role.model.js';
import { LeadStatus } from '../models/statusLists.model.js';
import { User } from '../models/user.model.js';
import { runSeed, seedStartingLists, seedStatusLists } from '../seeds/seed.js';
import { clearTestDb, startTestDbWithTransactions, stopTestDb } from './helpers/testDb.js';

const PASSWORD = 'correct-horse-battery';
const UNKNOWN_ID = '0123456789abcdef01234567';
let app;
let ceo;
let manager;
let agent;
let otherAgent;
let asCeo;
let asManager;
let asAgent;
let asOther;
let accountId;
let contactId;
let stages;

async function signedInAs(user) {
  const client = request.agent(app);
  const response = await client
    .post('/api/auth/login')
    .send({ email: user.email, password: PASSWORD });
  expect(response.status).toBe(200);
  return client;
}

const makeLead = async (client, body = {}) =>
  (await client.post('/api/opportunities').send({ name: 'OEE for press line', accountId, ...body }))
    .body.data;
const stageId = (key) => String(stages[key]._id);

beforeAll(async () => {
  // Creating a lead and changing its stage use a transaction.
  await startTestDbWithTransactions();
  app = createApp({ sessionMiddleware: createSessionMiddleware() });
});
afterAll(stopTestDb);

beforeEach(async () => {
  await clearTestDb();
  await runSeed({ productName: 'P', companyName: 'C', workspaceDomain: 'engenx.in' });
  await seedStatusLists();
  await seedStartingLists();
  const roles = Object.fromEntries((await Role.find()).map((role) => [role.name, role]));
  const makeUser = (email, name, roleName, extra = {}) =>
    User.create({
      email,
      name,
      roleId: roles[roleName]._id,
      status: 'active',
      password: PASSWORD,
      ...extra,
    });
  ceo = await makeUser('ceo@engenx.in', 'Kunal CEO', 'CEO');
  manager = await makeUser('manager@engenx.in', 'Meera Manager', 'Sales Manager');
  // The agent reports to the manager; the other agent reports to nobody.
  agent = await makeUser('agent@engenx.in', 'Asha Agent', 'Sales Agent', {
    managerId: manager._id,
  });
  otherAgent = await makeUser('other@engenx.in', 'Omar Agent', 'Sales Agent');
  [asCeo, asManager, asAgent, asOther] = await Promise.all(
    [ceo, manager, agent, otherAgent].map(signedInAs),
  );
  stages = Object.fromEntries(
    (await PipelineStage.find().lean()).map((stage) => [stage.key, stage]),
  );

  // A company the agent owns, with one person.
  const created = await asAgent.post('/api/accounts/quick-add').send({
    account: { name: 'Bharat Forge' },
    contacts: [{ name: 'Asha Verma', phone_number: '9876543210' }],
  });
  accountId = created.body.data.account.id;
  contactId = created.body.data.contacts[0].id;
  await AuditLog.deleteMany({});
});

describe('creating a lead', () => {
  it('gives it a code, the first stage, the default status and the creator as owner', async () => {
    const response = await asAgent.post('/api/opportunities').send({
      name: '  OEE for press line ',
      accountId,
      primaryContactId: contactId,
      estimatedValuePaise: 250000000,
      expectedCloseDate: '2026-12-31',
      nextAction: { text: 'Send the brochure', dueAt: '2026-10-12T05:30:00.000Z' },
    });
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      leadCode: 'EGL-10001',
      name: 'OEE for press line',
      account: { id: accountId, name: 'Bharat Forge', accountCode: 'EGX-10001' },
      primaryContact: { name: 'Asha Verma', phone_number: '+919876543210' },
      stage: { name: 'Lead', type: 'open' },
      leadStatus: { name: 'New Lead' },
      status: 'open',
      owner: { name: 'Asha Agent' },
      estimatedValuePaise: 250000000,
      probability: 5, // the stage's suggested chance
      source: 'manual',
      formFilledBy: { name: 'Asha Agent' },
      permissions: { canEdit: true, canDelete: false, canAssign: false },
    });
    // The end of the chosen day in India is still that day.
    expect(response.body.data.expectedCloseDate).toBe('2026-12-30T18:30:00.000Z');
    expect((await makeLead(asAgent)).leadCode).toBe('EGL-10002');

    const history = await StageHistory.find({ opportunityId: response.body.data.id }).lean();
    expect(history).toHaveLength(1);
    expect(history[0].fromStageId).toBeUndefined();
    expect(String(history[0].toStageId)).toBe(stageId('lead'));
    const entry = await AuditLog.findOne({ action: 'lead.created' }).sort({ _id: 1 }).lean();
    expect(entry.newValue).toMatchObject({ leadCode: 'EGL-10001', name: 'OEE for press line' });
  });

  it('refuses wrong input and links to another company’s records', async () => {
    const other = (
      await asCeo.post('/api/accounts/quick-add').send({
        account: { name: 'Tata Steel' },
        contacts: [{ name: 'Someone Else' }],
      })
    ).body.data;
    const cases = [
      [{ name: '' }, 400, 'name'],
      [{ accountId: 'nope' }, 400, 'accountId'],
      [{ probability: 140 }, 400, 'probability'],
      [{ expectedCloseDate: '31/12/2026' }, 400, 'expectedCloseDate'],
      [{ primaryContactId: other.contacts[0].id }, 400, 'primaryContactId'],
      [{ leadStatusId: UNKNOWN_ID }, 400, 'leadStatusId'],
      [{ solutionCategoryIds: [UNKNOWN_ID] }, 400, 'solutionCategoryIds'],
      [{ stageId: stageId('won') }, 400, 'stageId'],
      [{ stageId: UNKNOWN_ID }, 400, 'stageId'],
    ];
    for (const [body, status, field] of cases) {
      const response = await asAgent
        .post('/api/opportunities')
        .send({ name: 'X', accountId, ...body });
      expect(response.status, field).toBe(status);
      expect(response.body.error.details[0].field, field).toBe(field);
    }
    // A company the agent cannot see is "not found", and no code was used up by the refusals.
    expect(await makeLead(asAgent, { accountId: other.account.id })).toBeUndefined();
    expect(await Opportunity.countDocuments()).toBe(0);
    expect((await makeLead(asAgent)).leadCode).toBe('EGL-10001');
  });

  it('only someone who may assign can name another owner or leave it unassigned', async () => {
    const byAgent = await asAgent
      .post('/api/opportunities')
      .send({ name: 'X', accountId, ownerId: String(otherAgent._id) });
    expect(byAgent.status).toBe(403);
    expect(
      (await asAgent.post('/api/opportunities').send({ name: 'X', accountId, ownerId: null }))
        .status,
    ).toBe(403);

    const unassigned = await makeLead(asManager, { ownerId: null });
    expect(unassigned.owner).toBeNull();
    const given = await makeLead(asCeo, {
      ownerId: String(agent._id),
      assignedUserIds: [String(otherAgent._id)],
    });
    expect(given.owner.name).toBe('Asha Agent');
    expect(given.assignedUsers.map((user) => user.name)).toEqual(['Omar Agent']);
  });
});

describe('lead access by assignment (hard rule)', () => {
  let mine;
  let othersLead;
  let unassigned;
  let shared;

  beforeEach(async () => {
    mine = await makeLead(asAgent, { name: 'Mine' });
    othersLead = await makeLead(asCeo, {
      name: 'Of the other agent',
      ownerId: String(otherAgent._id),
    });
    unassigned = await makeLead(asCeo, { name: 'Nobody yet', ownerId: null });
    shared = await makeLead(asCeo, {
      name: 'Shared with me',
      assignedUserIds: [String(agent._id)],
    });
  });

  const namesSeenBy = async (client, query = '') =>
    (await client.get(`/api/opportunities?sort=name${query}`)).body.data.map((lead) => lead.name);

  it('lists: the CEO sees all, a manager the team’s and the unassigned, an agent only their own', async () => {
    expect(await namesSeenBy(asCeo)).toEqual([
      'Mine',
      'Nobody yet',
      'Of the other agent',
      'Shared with me',
    ]);
    // The agent reports to the manager; the other agent does not.
    expect(await namesSeenBy(asManager)).toEqual(['Mine', 'Nobody yet']);
    expect(await namesSeenBy(asAgent)).toEqual(['Mine', 'Shared with me']);
    expect(await namesSeenBy(asOther)).toEqual(['Of the other agent']);
    // Searching or filtering never widens it.
    expect(await namesSeenBy(asAgent, '&search=Nobody')).toEqual([]);
    expect(await namesSeenBy(asAgent, '&ownerId=unassigned')).toEqual([]);
    expect(await namesSeenBy(asAgent, `&ownerId=${otherAgent._id}`)).toEqual([]);
    expect(await namesSeenBy(asManager, '&ownerId=unassigned')).toEqual(['Nobody yet']);
  });

  it('an agent gets "not found" for every lead that is not theirs, whatever they try', async () => {
    for (const lead of [othersLead, unassigned]) {
      const url = `/api/opportunities/${lead.id}`;
      expect((await asAgent.get(url)).status).toBe(404);
      expect((await asAgent.patch(url).send({ name: 'Hacked' })).status).toBe(404);
      expect(
        (await asAgent.post(`${url}/stage`).send({ stageId: stageId('qualified') })).status,
      ).toBe(404);
      // An agent may not delete any lead at all: the same refusal for every id, real or not.
      expect((await asAgent.delete(url)).status).toBe(403);
    }
    expect((await asAgent.get(`/api/opportunities/${UNKNOWN_ID}`)).status).toBe(404);
    expect((await asAgent.delete(`/api/opportunities/${UNKNOWN_ID}`)).status).toBe(403);
    expect((await Opportunity.findById(othersLead.id).lean()).name).toBe('Of the other agent');

    // Their own and the shared one: every field can be edited; deleting is not theirs to do.
    expect((await asAgent.get(`/api/opportunities/${shared.id}`)).status).toBe(200);
    expect(
      (await asAgent.patch(`/api/opportunities/${shared.id}`).send({ requirement: 'OEE' })).status,
    ).toBe(200);
    expect((await asAgent.delete(`/api/opportunities/${mine.id}`)).status).toBe(403);
  });

  it('reassigning a lead away removes it from that agent at once; only an assigner can do it', async () => {
    const byAgent = await asAgent
      .patch(`/api/opportunities/${mine.id}`)
      .send({ ownerId: String(otherAgent._id) });
    expect(byAgent.status).toBe(403);

    const moved = await asManager
      .patch(`/api/opportunities/${mine.id}`)
      .send({ ownerId: String(otherAgent._id) });
    expect(moved.status).toBe(200);
    expect(moved.body.data.owner.name).toBe('Omar Agent');
    expect((await asAgent.get(`/api/opportunities/${mine.id}`)).status).toBe(404);
    expect(await namesSeenBy(asAgent)).toEqual(['Shared with me']);
    expect(await namesSeenBy(asOther)).toEqual(['Mine', 'Of the other agent']);

    const entry = await AuditLog.findOne({ action: 'lead.assignment_changed' }).lean();
    expect(String(entry.oldValue.ownerId)).toBe(String(agent._id));
    expect(String(entry.newValue.ownerId)).toBe(String(otherAgent._id));

    // A manager gives an unassigned lead to their agent; taking the owner away makes it unassigned.
    await asManager
      .patch(`/api/opportunities/${unassigned.id}`)
      .send({ ownerId: String(agent._id) });
    expect(await namesSeenBy(asAgent)).toEqual(['Nobody yet', 'Shared with me']);
    await asCeo.patch(`/api/opportunities/${unassigned.id}`).send({ ownerId: null });
    expect((await Opportunity.findById(unassigned.id).lean()).ownerId).toBeNull();
    expect(await namesSeenBy(asManager, '&ownerId=unassigned')).toEqual(['Nobody yet']);
  });
});

describe('editing a lead', () => {
  it('saves only what changed, merges small objects, clears with null, and audits old and new', async () => {
    const lead = await makeLead(asAgent, { requirement: 'Old', nextAction: { text: 'Call' } });
    const followUp = await LeadStatus.findOne({ name: 'Follow-up' }).lean();
    const response = await asAgent.patch(`/api/opportunities/${lead.id}`).send({
      name: lead.name, // unchanged
      requirement: 'OEE on 12 presses',
      leadStatusId: String(followUp._id),
      nextAction: { dueAt: '2026-10-15T04:30:00.000Z' },
      risk: { level: 'high', note: 'Budget not approved' },
      stakeholders: [{ contactId, buyingRole: 'champion' }],
    });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      requirement: 'OEE on 12 presses',
      leadStatus: { name: 'Follow-up' },
      nextAction: { text: 'Call', dueAt: '2026-10-15T04:30:00.000Z' },
      risk: { level: 'high', note: 'Budget not approved' },
      stakeholders: [{ contact: { name: 'Asha Verma' }, buyingRole: 'champion' }],
    });
    const entry = await AuditLog.findOne({ action: 'lead.updated' }).lean();
    expect(Object.keys(entry.newValue).sort()).toEqual([
      'leadStatusId',
      'nextAction',
      'requirement',
      'risk',
      'stakeholders',
    ]);
    expect(entry.oldValue.requirement).toBe('Old');

    const cleared = await asAgent
      .patch(`/api/opportunities/${lead.id}`)
      .send({ requirement: null });
    expect(cleared.body.data.requirement).toBeNull();
    // Saving the same values again writes nothing.
    await AuditLog.deleteMany({});
    await asAgent
      .patch(`/api/opportunities/${lead.id}`)
      .send({ requirement: null, name: lead.name });
    expect(await AuditLog.countDocuments()).toBe(0);
    expect((await asAgent.patch(`/api/opportunities/${lead.id}`).send({})).status).toBe(400);
  });

  it('warns instead of overwriting when someone else saved in between', async () => {
    const lead = await makeLead(asAgent);
    // The CEO saves while the agent's form is still open.
    await asCeo.patch(`/api/opportunities/${lead.id}`).send({ requirement: 'From the CEO' });

    const stale = await asAgent
      .patch(`/api/opportunities/${lead.id}`)
      .send({ requirement: 'From the agent', expectedUpdatedAt: lead.updatedAt });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details[0].code).toBe('STALE_DATA');
    expect((await Opportunity.findById(lead.id).lean()).requirement).toBe('From the CEO');

    // After seeing the newer values the agent chooses to save anyway.
    const forced = await asAgent.patch(`/api/opportunities/${lead.id}`).send({
      requirement: 'From the agent',
      expectedUpdatedAt: lead.updatedAt,
      overwrite: true,
    });
    expect(forced.status).toBe(200);
    // With the current time stamp there is nothing to warn about.
    const fresh = await asAgent
      .patch(`/api/opportunities/${lead.id}`)
      .send({ competitor: 'Siemens', expectedUpdatedAt: forced.body.data.updatedAt });
    expect(fresh.status).toBe(200);
  });
});

describe('the stage service', () => {
  it('a move writes the lead, one history row and one audit entry, wherever it comes from', async () => {
    const lead = await makeLead(asAgent);
    const moved = await asAgent
      .post(`/api/opportunities/${lead.id}/stage`)
      .send({ stageId: stageId('qualified'), via: 'pipeline' });
    expect(moved.status).toBe(200);
    expect(moved.body.data).toMatchObject({
      stage: { name: 'Qualified' },
      status: 'open',
      probability: 10,
    });

    // The same service is used when the stage is changed in the edit form.
    const viaForm = await asAgent
      .patch(`/api/opportunities/${lead.id}`)
      .send({ stageId: stageId('proposal'), requirement: 'With the stage' });
    expect(viaForm.body.data).toMatchObject({
      stage: { name: 'Proposal' },
      requirement: 'With the stage',
    });

    const history = await StageHistory.find({ opportunityId: lead.id })
      .sort({ changedAt: 1 })
      .lean();
    expect(history.map((row) => row.via)).toEqual([undefined, 'pipeline', 'edit_form']);
    expect(String(history[2].fromStageId)).toBe(stageId('qualified'));
    expect(history[2].msInPreviousStage).toBeGreaterThanOrEqual(0);
    expect(String(history[2].changedBy)).toBe(String(agent._id));
    const audits = await AuditLog.find({ action: 'lead.stage_changed' }).sort({ _id: 1 }).lean();
    expect(audits.map((entry) => [entry.oldValue.stage, entry.newValue.stage])).toEqual([
      ['Lead', 'Qualified'],
      ['Qualified', 'Proposal'],
    ]);

    // Moving to the stage it is in already changes nothing.
    await asAgent
      .post(`/api/opportunities/${lead.id}/stage`)
      .send({ stageId: stageId('proposal') });
    expect(await StageHistory.countDocuments({ opportunityId: lead.id })).toBe(3);
  });

  it('won and lost need a reason; reopening clears it', async () => {
    const lead = await makeLead(asAgent);
    const url = `/api/opportunities/${lead.id}/stage`;
    const noReason = await asAgent.post(url).send({ stageId: stageId('lost') });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.details[0].field).toBe('closeReason');
    // Refused: nothing is half-written.
    expect((await Opportunity.findById(lead.id).lean()).status).toBe('open');
    expect(await StageHistory.countDocuments({ opportunityId: lead.id })).toBe(1);

    const lost = await asAgent
      .post(url)
      .send({ stageId: stageId('lost'), closeReason: 'Price', lostToCompetitor: 'Siemens' });
    expect(lost.body.data).toMatchObject({
      status: 'lost',
      closeReason: 'Price',
      lostToCompetitor: 'Siemens',
      probability: 0,
    });
    expect(lost.body.data.closedAt).toBeTruthy();
    expect((await asAgent.get('/api/opportunities?status=lost')).body.data).toHaveLength(1);

    const won = await asAgent
      .post(url)
      .send({ stageId: stageId('won'), closeReason: 'PO received' });
    expect(won.body.data).toMatchObject({
      status: 'won',
      closeReason: 'PO received',
      lostToCompetitor: null,
    });

    const reopened = await asAgent.post(url).send({ stageId: stageId('proposal') });
    expect(reopened.body.data).toMatchObject({ status: 'open', closedAt: null, closeReason: null });
  });

  it('refuses a stage that does not exist or is switched off', async () => {
    const lead = await makeLead(asAgent);
    await PipelineStage.updateOne({ key: 'pilot_poc' }, { $set: { isActive: false } });
    for (const id of [UNKNOWN_ID, stageId('pilot_poc')]) {
      const response = await asAgent
        .post(`/api/opportunities/${lead.id}/stage`)
        .send({ stageId: id });
      expect(response.status).toBe(400);
      expect(response.body.error.details[0].field).toBe('stageId');
    }
  });
});

describe('filters, delete, and what leads block', () => {
  it('filters combine, and the list is paged and sorted', async () => {
    const big = await makeLead(asAgent, { name: 'Big', estimatedValuePaise: 900000000 });
    await makeLead(asAgent, { name: 'Small', estimatedValuePaise: 1000000 });
    await asAgent.post(`/api/opportunities/${big.id}/stage`).send({ stageId: stageId('proposal') });

    const get = async (query) => (await asAgent.get(`/api/opportunities?${query}`)).body;
    expect((await get('minValue=5000000')).data.map((lead) => lead.name)).toEqual(['Big']);
    expect((await get(`stageId=${stageId('proposal')}&search=big`)).data).toHaveLength(1);
    expect((await get(`stageId=${stageId('proposal')}&maxValue=5`)).data).toHaveLength(0);
    expect((await get(`accountId=${accountId}&sort=-estimatedValuePaise`)).data[0].name).toBe(
      'Big',
    );
    expect((await get('search=EGL-10002')).data.map((lead) => lead.name)).toEqual(['Small']);
    expect((await get('pageSize=1&sort=name')).meta).toEqual({ page: 1, pageSize: 1, total: 2 });
    expect((await asAgent.get('/api/opportunities?sort=password')).status).toBe(400);
    expect((await request(app).get('/api/opportunities')).status).toBe(401);
  });

  it('a deleted lead disappears; a company with open leads cannot be deleted', async () => {
    const lead = await makeLead(asAgent);
    const blocked = await asCeo.delete(`/api/accounts/${accountId}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain('1 open lead');

    expect((await asManager.delete(`/api/opportunities/${lead.id}`)).status).toBe(200);
    expect((await asAgent.get(`/api/opportunities/${lead.id}`)).status).toBe(404);
    expect((await asAgent.get('/api/opportunities')).body.data).toEqual([]);
    expect((await Opportunity.findById(lead.id).lean()).leadCode).toBe('EGL-10001');
    expect((await asCeo.delete(`/api/accounts/${accountId}`)).status).toBe(200);
  });

  it('form options: the lists, and the people only for someone who may assign', async () => {
    const forAgent = (await asAgent.get('/api/opportunities/form-options')).body.data;
    expect(forAgent.stages).toHaveLength(15);
    expect(forAgent.stages[0]).toMatchObject({ name: 'Lead', type: 'open', defaultProbability: 5 });
    expect(forAgent.leadStatuses).toHaveLength(16);
    expect(forAgent.solutionCategories).toHaveLength(16);
    expect(forAgent).toMatchObject({ canAssign: false, users: [{ name: 'Asha Agent' }] });
    const forManager = (await asManager.get('/api/opportunities/form-options')).body.data;
    expect(forManager.canAssign).toBe(true);
    expect(forManager.users).toHaveLength(4);
  });
});

describe('pipeline stages as a managed list', () => {
  const base = '/api/status-lists/pipeline-stages';

  it('stages are added with a type and a chance, renamed, reordered and switched off', async () => {
    const list = (await asAgent.get(base)).body.data;
    expect(list).toHaveLength(15);
    expect(list[0]).toMatchObject({
      name: 'Lead',
      key: 'lead',
      type: 'open',
      defaultProbability: 5,
    });

    const added = await asCeo.post(base).send({ name: 'On hold', defaultProbability: 20 });
    expect(added.status).toBe(201);
    expect(added.body.data).toMatchObject({ key: 'on_hold', type: 'open', defaultProbability: 20 });
    const id = added.body.data.id;
    expect(
      (await asCeo.patch(`${base}/${id}`).send({ name: 'Parked', defaultProbability: null })).body
        .data,
    ).toMatchObject({ name: 'Parked', key: 'on_hold', defaultProbability: null });
    expect((await asCeo.patch(`${base}/${id}`).send({ isDefault: true })).status).toBe(400);
    expect((await asCeo.patch(`${base}/${id}`).send({ isActive: false })).status).toBe(200);
    expect((await asAgent.post(base).send({ name: 'Nope' })).status).toBe(403);
    // Type and chance belong to pipeline stages only.
    expect(
      (await asCeo.post('/api/status-lists/lead-statuses').send({ name: 'X', type: 'won' })).status,
    ).toBe(400);
  });

  it('keeps one active stage of each type, and protects stages that leads are in', async () => {
    const wonId = stageId('won');
    // Each request is made when its turn comes.
    for (const send of [
      () => asCeo.patch(`${base}/${wonId}`).send({ isActive: false }),
      () => asCeo.patch(`${base}/${wonId}`).send({ type: 'open' }),
      () => asCeo.delete(`${base}/${wonId}`),
    ]) {
      const response = await send();
      expect(response.status).toBe(409);
      expect(response.body.error.message).toContain('only active "won" stage');
    }

    const lead = await makeLead(asAgent);
    expect(lead.stage.name).toBe('Lead');
    const inUse = await asCeo.delete(`${base}/${stageId('lead')}`);
    expect(inUse.status).toBe(409);
    expect(inUse.body.error.message).toContain('1 record has this pipeline stage');
    expect((await asCeo.patch(`${base}/${stageId('lead')}`).send({ type: 'lost' })).status).toBe(
      409,
    );
    // A lead status in use is protected the same way.
    const newLead = await LeadStatus.findOne({ name: 'New Lead' }).lean();
    expect(
      (await asCeo.patch(`/api/status-lists/lead-statuses/${newLead._id}`).send({ name: 'Fresh' }))
        .status,
    ).toBe(200);
    expect((await asCeo.delete(`/api/status-lists/lead-statuses/${newLead._id}`)).status).toBe(409);
    expect((await asAgent.get(`/api/opportunities/${lead.id}`)).body.data.leadStatus.name).toBe(
      'Fresh',
    );
  });
});

describe('the pipeline board and the stage history', () => {
  it('groups the leads a person may see by stage, with counts and totals', async () => {
    const mine = await makeLead(asAgent, { name: 'Mine', estimatedValuePaise: 100000 });
    await makeLead(asAgent, { name: 'Mine too', estimatedValuePaise: 250000 });
    await makeLead(asCeo, { name: 'Not mine', ownerId: String(otherAgent._id) });
    await asAgent
      .post(`/api/opportunities/${mine.id}/stage`)
      .send({ stageId: stageId('proposal') });
    await PipelineStage.updateOne({ key: 'pilot_poc' }, { $set: { isActive: false } });

    const board = (await asAgent.get('/api/opportunities/board')).body.data;
    // Every active stage is a column, in pipeline order; a switched-off stage is not.
    expect(board).toHaveLength(14);
    expect(board[0].stage).toMatchObject({ name: 'Lead', type: 'open' });
    expect(board.map((column) => column.stage.name)).not.toContain('Pilot / PoC');
    const column = (name) => board.find((item) => item.stage.name === name);
    expect(column('Lead')).toMatchObject({ count: 1, valuePaise: 250000 });
    expect(column('Lead').leads.map((lead) => lead.name)).toEqual(['Mine too']);
    expect(column('Proposal')).toMatchObject({ count: 1, valuePaise: 100000 });
    expect(column('Won')).toMatchObject({ count: 0, valuePaise: 0, leads: [] });

    // The CEO sees the third lead as well; filters narrow the board like the list.
    const forCeo = (await asCeo.get('/api/opportunities/board')).body.data;
    expect(forCeo[0].count).toBe(2);
    const filtered = (await asCeo.get(`/api/opportunities/board?ownerId=${otherAgent._id}`)).body
      .data;
    expect(filtered[0].leads.map((lead) => lead.name)).toEqual(['Not mine']);
    expect((await asCeo.get('/api/opportunities/board?search=too')).body.data[0].count).toBe(1);
    expect((await request(app).get('/api/opportunities/board')).status).toBe(401);
  });

  it('a lead shows the stages it went through; another person’s lead shows nothing', async () => {
    const lead = await makeLead(asAgent);
    await asAgent
      .post(`/api/opportunities/${lead.id}/stage`)
      .send({ stageId: stageId('qualified'), via: 'pipeline' });
    const history = (await asAgent.get(`/api/opportunities/${lead.id}/stage-history`)).body.data;
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      from: { name: 'Lead' },
      to: { name: 'Qualified' },
      changedBy: { name: 'Asha Agent' },
      via: 'pipeline',
    });
    expect(history[1]).toMatchObject({ from: null, to: { name: 'Lead' } });
    expect((await asOther.get(`/api/opportunities/${lead.id}/stage-history`)).status).toBe(404);
  });
});

describe('the "New" form with a lead', () => {
  it('creates the company, its people and the first lead together', async () => {
    const response = await asAgent.post('/api/accounts/quick-add').send({
      account: { name: 'Thermax' },
      contacts: [{ name: 'Rajesh Sen', phone_number: '9123456780' }, { name: 'Second Person' }],
      lead: {
        name: 'Boiler monitoring',
        estimatedValuePaise: 90000000,
        requirement: 'Pilot first',
      },
    });
    expect(response.status).toBe(201);
    const { account, contacts, lead } = response.body.data;
    expect(contacts).toHaveLength(2);
    expect(lead).toMatchObject({
      leadCode: 'EGL-10001',
      name: 'Boiler monitoring',
      account: { id: account.id, name: 'Thermax' },
      // The first person of the form is the lead's main contact.
      primaryContact: { name: 'Rajesh Sen', phone_number: '+919123456780' },
      stage: { name: 'Lead' },
      owner: { name: 'Asha Agent' },
      estimatedValuePaise: 90000000,
    });
    // Without a lead part, none is made.
    const plain = await asAgent
      .post('/api/accounts/quick-add')
      .send({ account: { name: 'Plain Co' } });
    expect(plain.body.data.lead).toBeNull();
    expect(await Opportunity.countDocuments()).toBe(1);
  });

  it('when the lead cannot be saved, the company and its people are not left behind', async () => {
    const before = await asAgent.get('/api/accounts');
    const response = await asAgent.post('/api/accounts/quick-add').send({
      account: { name: 'Half Saved Co' },
      contacts: [{ name: 'Someone' }],
      // A new lead cannot start as won.
      lead: { name: 'Bad lead', stageId: stageId('won') },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.details[0].field).toBe('stageId');
    expect((await asAgent.get('/api/accounts')).body.meta.total).toBe(before.body.meta.total);
    expect((await asAgent.get('/api/accounts?search=Half')).body.data).toEqual([]);
    expect(await Opportunity.countDocuments()).toBe(0);
    // The corrected form goes through, without a "similar name" warning about its own first try.
    const again = await asAgent.post('/api/accounts/quick-add').send({
      account: { name: 'Half Saved Co' },
      contacts: [{ name: 'Someone' }],
      lead: { name: 'Good lead' },
    });
    expect(again.status).toBe(201);
    expect(
      (
        await asAgent
          .post('/api/accounts/quick-add')
          .send({ account: { name: 'X' }, lead: { name: '' } })
      ).status,
    ).toBe(400);
  });
});

describe('editing the company and the main contact from the lead form', () => {
  it('saves all three through their own services, and says what the person may change', async () => {
    const lead = await makeLead(asAgent, { primaryContactId: contactId });
    const before = (await asAgent.get(`/api/opportunities/${lead.id}`)).body.data;
    expect(before).toMatchObject({ canEditAccount: true, canEditContact: true });
    expect(before.accountDetails).toMatchObject({ industry: null, city: null });

    const saved = await asAgent.patch(`/api/opportunities/${lead.id}`).send({
      requirement: 'OEE on 12 presses',
      contact: { designation: 'Plant Head', phone_number: '91234 56780' },
      account: { industry: 'Forging', hq: { city: 'Pune' } },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({
      requirement: 'OEE on 12 presses',
      primaryContact: { designation: 'Plant Head', phone_number: '+919123456780' },
      accountDetails: { industry: 'Forging', city: 'Pune' },
    });
    const actions = (await AuditLog.find().lean()).map((entry) => entry.action);
    expect(actions).toEqual(
      expect.arrayContaining(['account.updated', 'contact.updated', 'lead.updated']),
    );

    // Only the company part is sent: the lead itself is left as it is.
    const onlyCompany = await asAgent
      .patch(`/api/opportunities/${lead.id}`)
      .send({ account: { website: 'bharatforge.com' } });
    expect(onlyCompany.body.data.accountDetails.website).toBe('https://bharatforge.com');
  });

  it('a wrong value in the contact or company part stops the whole save', async () => {
    const lead = await makeLead(asAgent, { primaryContactId: contactId });
    const response = await asAgent.patch(`/api/opportunities/${lead.id}`).send({
      requirement: 'Must not be saved',
      contact: { phone_number: '12345' },
    });
    expect(response.status).toBe(400);
    expect((await Opportunity.findById(lead.id).lean()).requirement).toBeUndefined();

    const noContact = await makeLead(asAgent, { name: 'No contact' });
    const refused = await asAgent
      .patch(`/api/opportunities/${noContact.id}`)
      .send({ contact: { designation: 'X' } });
    expect(refused.status).toBe(400);
  });

  it('someone assigned to the lead but not to its company cannot change the company through it', async () => {
    // The CEO's own company; the lead on it is given to the agent.
    const company = (
      await asCeo
        .post('/api/accounts/quick-add')
        .send({ account: { name: 'Tata Steel' }, contacts: [{ name: 'Their Person' }] })
    ).body.data;
    const lead = (
      await asCeo.post('/api/opportunities').send({
        name: 'Given to the agent',
        accountId: company.account.id,
        primaryContactId: company.contacts[0].id,
        ownerId: String(agent._id),
      })
    ).body.data;

    const seen = (await asAgent.get(`/api/opportunities/${lead.id}`)).body.data;
    expect(seen).toMatchObject({ canEditAccount: false, canEditContact: false });
    // The lead's own fields: yes. The company and its person: no.
    expect(
      (await asAgent.patch(`/api/opportunities/${lead.id}`).send({ requirement: 'Mine to edit' }))
        .status,
    ).toBe(200);
    for (const body of [
      { account: { industry: 'Changed' } },
      { contact: { designation: 'Changed' } },
    ]) {
      expect((await asAgent.patch(`/api/opportunities/${lead.id}`).send(body)).status).toBe(404);
    }
    const untouched = (await asCeo.get(`/api/accounts/${company.account.id}`)).body.data;
    expect(untouched.industry ?? null).toBeNull();
  });
});

describe('leads export', () => {
  it('needs the export permission and holds only leads inside the person’s scope', async () => {
    const mine = await makeLead(asAgent, {
      name: '=HYPERLINK("http://evil.example")',
      primaryContactId: contactId,
      estimatedValuePaise: 250000050,
      expectedCloseDate: '2026-12-31',
    });
    await makeLead(asCeo, { name: 'Of the other agent', ownerId: String(otherAgent._id) });
    await asAgent
      .post(`/api/opportunities/${mine.id}/stage`)
      .send({ stageId: stageId('proposal') });

    expect((await request(app).get('/api/opportunities/export')).status).toBe(401);
    // An agent has no export permission.
    expect((await asAgent.get('/api/opportunities/export')).status).toBe(403);

    // The manager's team scope: the agent's lead, not the other agent's.
    const response = await asManager.get('/api/opportunities/export?sort=name');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toMatch(
      /filename="leads-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    const lines = response.text.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe(
      'Code,Lead,Company,Stage,Status,Open / won / lost,Estimated value (INR),Chance (%),Expected close,Owner,Main contact,Contact phone,Contact email,Solutions,Tags,Next action,Created',
    );
    expect(lines).toHaveLength(2);
    // The formula is made harmless (so is the "+" of a phone number: it stays text in a
    // spreadsheet); the value is in rupees; the date is the Indian day.
    expect(lines[1]).toContain(
      'EGL-10001,"\'=HYPERLINK(""http://evil.example"")",Bharat Forge,Proposal,New Lead,open,2500000.5,50,2026-12-31,Asha Agent,Asha Verma,\'+919876543210',
    );
    expect(response.text).not.toContain('Of the other agent');

    expect(
      (await asCeo.get('/api/opportunities/export')).text.slice(1).trim().split('\r\n'),
    ).toHaveLength(3);
    expect(
      (await asCeo.get(`/api/opportunities/export?stageId=${stageId('won')}`)).text
        .slice(1)
        .trim()
        .split('\r\n'),
    ).toHaveLength(1);
    const entry = await AuditLog.findOne({ action: 'lead.exported' }).sort({ _id: 1 }).lean();
    expect(entry.newValue).toMatchObject({ leads: 1, filters: { sort: 'name' } });
  });
});
