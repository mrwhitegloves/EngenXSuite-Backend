import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { createSessionMiddleware } from '../middleware/session.js';
import { Role } from '../models/role.model.js';
import { User } from '../models/user.model.js';
import { runSeed, seedStartingLists, seedStatusLists } from '../seeds/seed.js';
import { loadRequestUser } from '../services/auth.service.js';
import { getTodayDashboard } from '../services/dashboards.service.js';
import { clearTestDb, startTestDbWithTransactions, stopTestDb } from './helpers/testDb.js';

const PASSWORD = 'correct-horse-battery';
let app;
let ceo;
let agent;
let otherAgent;
let asCeo;
let asManager;
let asAgent;
let asOther;
let mine;
let theirs;

async function signedInAs(user) {
  const client = request.agent(app);
  const response = await client
    .post('/api/auth/login')
    .send({ email: user.email, password: PASSWORD });
  expect(response.status).toBe(200);
  return client;
}

const search = async (client, q) =>
  (await client.get(`/api/search?q=${encodeURIComponent(q)}`)).body.data;
const names = (items) => items.map((item) => item.name).sort();

beforeAll(async () => {
  // Creating a lead uses a transaction.
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
  const manager = await makeUser('manager@engenx.in', 'Meera Manager', 'Sales Manager');
  agent = await makeUser('agent@engenx.in', 'Asha Agent', 'Sales Agent', {
    managerId: manager._id,
  });
  otherAgent = await makeUser('other@engenx.in', 'Omar Agent', 'Sales Agent');
  [asCeo, asManager, asAgent, asOther] = await Promise.all(
    [ceo, manager, agent, otherAgent].map(signedInAs),
  );

  // The agent's company with a person and a lead; and the other agent's.
  const quickAdd = async (client, name, person, phone) =>
    (
      await client.post('/api/accounts/quick-add').send({
        account: { name, hq: { city: 'Pune' } },
        contacts: [{ name: person, phone_number: phone, designation: 'Plant Head' }],
      })
    ).body.data;
  mine = await quickAdd(asAgent, 'Bharat Forge', 'Asha Verma', '9876543210');
  theirs = await quickAdd(asOther, 'Bharat Electronics', 'Omar Sheikh', '9123456780');
  const lead = (client, account, body) =>
    client
      .post('/api/opportunities')
      .send({ accountId: account.account.id, primaryContactId: account.contacts[0].id, ...body });
  mine.lead = (await lead(asAgent, mine, { name: 'OEE for press line' })).body.data;
  theirs.lead = (await lead(asOther, theirs, { name: 'OEE for radar line' })).body.data;
  await asAgent
    .post('/api/tasks')
    .send({ title: 'Send the OEE proposal', opportunityId: mine.lead.id });
  await asOther
    .post('/api/tasks')
    .send({ title: 'Send the OEE quote', opportunityId: theirs.lead.id });
});

describe('global search', () => {
  it('finds companies, people, leads and tasks, each with enough to recognise it', async () => {
    const found = await search(asCeo, 'bharat');
    expect(names(found.accounts)).toEqual(['Bharat Electronics', 'Bharat Forge']);
    expect(found.accounts[1]).toMatchObject({ accountCode: 'EGX-10001', detail: 'Pune' });
    // A lead is found by the name of its company too.
    expect(names(found.leads)).toEqual(['OEE for press line', 'OEE for radar line']);
    expect(found.leads.find((lead) => lead.name === 'OEE for press line')).toMatchObject({
      leadCode: 'EGL-10001',
      detail: 'Bharat Forge · Lead',
    });

    const byPerson = await search(asCeo, 'asha v');
    expect(byPerson.contacts).toEqual([
      {
        id: mine.contacts[0].id,
        name: 'Asha Verma',
        accountId: mine.account.id,
        detail: 'Plant Head · Bharat Forge · +919876543210',
      },
    ]);
    expect(names(byPerson.leads)).toEqual(['OEE for press line']);

    const tasks = (await search(asCeo, 'oee')).tasks;
    expect(names(tasks)).toEqual(['Send the OEE proposal', 'Send the OEE quote']);
    expect(tasks[0]).toMatchObject({ detail: 'Open' });
    expect(tasks.every((task) => task.leadId)).toBe(true);
  });

  it('finds a phone number however it is typed', async () => {
    for (const typed of ['9876543210', '98765 43210', '098765-43210', '+91 98765 43210', '76543']) {
      const found = await search(asCeo, typed);
      expect(names(found.contacts), typed).toEqual(['Asha Verma']);
      // The lead whose contact has that number.
      expect(names(found.leads), typed).toEqual(['OEE for press line']);
    }
    expect((await search(asCeo, 'EGL-10002')).leads[0].name).toBe('OEE for radar line');
    expect((await search(asCeo, 'egx-10002')).accounts[0].name).toBe('Bharat Electronics');
  });

  it('never shows what the person may not see, whatever they type', async () => {
    for (const typed of [
      'bharat',
      'oee',
      'omar',
      '9123456780',
      'EGL-10002',
      'radar',
      'Electronics',
    ]) {
      const found = await search(asAgent, typed);
      const all = JSON.stringify(found);
      expect(all, typed).not.toContain('Electronics');
      expect(all, typed).not.toContain('radar');
      expect(all, typed).not.toContain('Omar');
      expect(all, typed).not.toContain('quote');
    }
    const found = await search(asAgent, 'bharat');
    expect(names(found.accounts)).toEqual(['Bharat Forge']);
    expect(names(found.leads)).toEqual(['OEE for press line']);
    expect(names((await search(asAgent, 'oee')).tasks)).toEqual(['Send the OEE proposal']);
    // The agent's manager finds the team's records, not the other agent's.
    expect(names((await search(asManager, 'oee')).leads)).toEqual(['OEE for press line']);

    // A lead of the agent's own company that belongs to someone else stays hidden.
    await asCeo.post('/api/opportunities').send({
      name: 'Secret OEE deal',
      accountId: mine.account.id,
      ownerId: String(otherAgent._id),
    });
    expect(JSON.stringify(await search(asAgent, 'forge'))).not.toContain('Secret');
    expect(names((await search(asOther, 'secret')).leads)).toEqual(['Secret OEE deal']);
    // … and the other agent, who sees that lead, does not get the company or its people with it.
    const forOther = await search(asOther, 'forge');
    expect(forOther.accounts).toEqual([]);
    expect(forOther.contacts).toEqual([]);
  });

  it('needs sign-in and at least two characters; special characters are plain text', async () => {
    expect((await request(app).get('/api/search?q=bharat')).status).toBe(401);
    expect((await asCeo.get('/api/search?q=b')).status).toBe(400);
    expect((await asCeo.get('/api/search')).status).toBe(400);
    const found = await search(asCeo, '.*');
    expect(found).toEqual({ accounts: [], contacts: [], leads: [], tasks: [] });
  });
});

describe('the dashboard', () => {
  // "Now" is 12:00 in India on 10 October 2026.
  const now = new Date('2026-10-10T06:30:00.000Z');
  const at = (hours) => new Date(now.getTime() + hours * 3600_000).toISOString();

  it('shows my tasks of today and overdue, and the leads that need me', async () => {
    await asAgent.post('/api/tasks').send({ title: 'Due this evening', dueAt: at(6) });
    await asAgent.post('/api/tasks').send({ title: 'Was due yesterday', dueAt: at(-24) });
    await asAgent.post('/api/tasks').send({ title: 'Next week', dueAt: at(24 * 7) });
    await asAgent.patch(`/api/opportunities/${mine.lead.id}`).send({
      estimatedValuePaise: 250000000,
      expectedCloseDate: '2026-10-15',
      nextAction: { text: 'Send the brochure', dueAt: at(-2) },
    });

    const board = await getTodayDashboard(await loadRequestUser(agent._id), now);
    expect(board.tasks.counts).toEqual({ today: 1, overdue: 1, upcoming: 2 });
    expect(board.tasks.today.map((task) => task.title)).toEqual(['Due this evening']);
    expect(board.tasks.overdue.map((task) => task.title)).toEqual(['Was due yesterday']);
    expect(board.leads).toMatchObject({
      openCount: 1,
      openValuePaise: 250000000,
      unassignedCount: null,
    });
    expect(board.leads.needAction).toEqual([
      expect.objectContaining({
        name: 'OEE for press line',
        accountName: 'Bharat Forge',
        stageName: 'Lead',
        ownerName: 'Asha Agent',
        nextAction: expect.objectContaining({ text: 'Send the brochure' }),
      }),
    ]);
    expect(board.leads.closingSoon.map((lead) => lead.name)).toEqual(['OEE for press line']);

    // The CEO: every open lead, the unassigned ones counted, and only the CEO's own tasks.
    await asCeo
      .post('/api/opportunities')
      .send({ name: 'Nobody yet', accountId: mine.account.id, ownerId: null });
    const forCeo = await getTodayDashboard(await loadRequestUser(ceo._id), now);
    expect(forCeo.leads).toMatchObject({ openCount: 3, unassignedCount: 1 });
    expect(forCeo.tasks.today).toEqual([]);
    // The other agent sees nothing of this.
    const forOther = await getTodayDashboard(await loadRequestUser(otherAgent._id), now);
    expect(forOther.leads).toMatchObject({ openCount: 1, needAction: [], closingSoon: [] });
    expect(JSON.stringify(forOther)).not.toContain('press line');

    expect((await asAgent.get('/api/dashboard/today')).status).toBe(200);
    expect((await request(app).get('/api/dashboard/today')).status).toBe(401);
  });
});
