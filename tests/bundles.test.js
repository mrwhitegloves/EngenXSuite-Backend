import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

// Bundles (lists of people and companies for bulk sending) and what is done with many
// companies at once from the Accounts screen: assign, export, make a bundle.

const { createApp } = await import('../app.js');
const { createSessionMiddleware } = await import('../middleware/session.js');
const { Account } = await import('../models/account.model.js');
const { Role } = await import('../models/role.model.js');
const { User } = await import('../models/user.model.js');
const { runSeed, seedStartingLists, seedStatusLists } = await import('../seeds/seed.js');
const { clearTestDb, startTestDbWithTransactions, stopTestDb } =
  await import('./helpers/testDb.js');

const PASSWORD = 'correct-horse-battery';
let app;
let asCeo;
let asManager;
let asAgent;
let agentId;
let managerId;
let forge; // a company with two people and a lead
let works; // a company with one person without email, and its own address

async function signedInAs(user) {
  const client = request.agent(app);
  const response = await client
    .post('/api/auth/login')
    .send({ email: user.email, password: PASSWORD });
  expect(response.status).toBe(200);
  return client;
}
const membersOf = async (client, id) => (await client.get(`/api/bundles/${id}`)).body.data.members;

beforeAll(async () => {
  await startTestDbWithTransactions(); // creating a lead uses a transaction
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
  const ceo = await makeUser('ceo@engenx.in', 'Kunal CEO', 'CEO');
  const manager = await makeUser('mira@engenx.in', 'Mira Manager', 'Sales Manager');
  const agent = await makeUser('asha@engenx.in', 'Asha Agent', 'Sales Agent', {
    managerId: manager._id,
  });
  agentId = String(agent._id);
  managerId = String(manager._id);
  [asCeo, asManager, asAgent] = await Promise.all([ceo, manager, agent].map(signedInAs));
  forge = (
    await asCeo.post('/api/accounts/quick-add').send({
      account: { name: 'Bharat Forge', email: 'info@bharatforge.example' },
      contacts: [
        { name: 'Asha Verma', email: 'asha.verma@bharatforge.example' },
        { name: 'Ravi Kumar', email: 'ravi@bharatforge.example' },
      ],
      lead: { name: 'OEE for press line' },
    })
  ).body.data;
  works = (
    await asCeo.post('/api/accounts/quick-add').send({
      account: { name: 'Shakti Works', email: 'office@shakti.example' },
      contacts: [{ name: 'No Address' }],
    })
  ).body.data;
});

describe('bundles', () => {
  it('are made from companies: their people and their own address, each once', async () => {
    const made = await asCeo
      .post('/api/bundles')
      .send({ name: 'Press shops', accountIds: [forge.account.id, works.account.id] });
    expect(made.status).toBe(201);
    expect(made.body.data).toMatchObject({ name: 'Press shops', memberCount: 4, added: 4 });

    const members = await membersOf(asCeo, made.body.data.id);
    expect(members.map((item) => [item.kind, item.name, item.email, item.company.name])).toEqual([
      ['person', 'Asha Verma', 'asha.verma@bharatforge.example', 'Bharat Forge'],
      ['person', 'Ravi Kumar', 'ravi@bharatforge.example', 'Bharat Forge'],
      ['company', 'Bharat Forge', 'info@bharatforge.example', 'Bharat Forge'],
      // The person of Shakti Works has neither email nor phone: not worth a place.
      ['company', 'Shakti Works', 'office@shakti.example', 'Shakti Works'],
    ]);
    expect(members[0].leads).toMatchObject([{ name: 'OEE for press line' }]);
    expect(members[0].leadId).toBe(forge.lead.id);

    // Added again: nobody joins twice.
    const again = await asCeo
      .post(`/api/bundles/${made.body.data.id}/members`)
      .send({ accountIds: [forge.account.id] });
    expect(again.body.data).toEqual({ added: 0, memberCount: 4 });
  });

  it('can be renamed, lose a member, gain one that is found by a search, and be deleted', async () => {
    const bundle = (
      await asCeo
        .post('/api/bundles')
        .send({ name: 'Only people', accountIds: [forge.account.id], includeCompany: false })
    ).body.data;
    expect(bundle.memberCount).toBe(2);
    const [first] = await membersOf(asCeo, bundle.id);

    expect(
      (await asCeo.patch(`/api/bundles/${bundle.id}`).send({ name: 'Forge people' })).body.data
        .name,
    ).toBe('Forge people');
    expect((await asCeo.patch(`/api/bundles/${bundle.id}`).send({ name: ' ' })).status).toBe(400);
    const removed = await asCeo.delete(`/api/bundles/${bundle.id}/members/${first.id}`);
    expect(removed.body.data).toEqual({ removed: true, memberCount: 1 });
    expect((await asCeo.delete(`/api/bundles/${bundle.id}/members/${first.id}`)).status).toBe(404);

    // Who can still be added: the removed person and the company's address, not who is in it.
    const found = (await asCeo.get(`/api/bundles/${bundle.id}/candidates?search=forge`)).body.data;
    expect(found.map((item) => [item.kind, item.name])).toEqual([
      ['person', 'Asha Verma'],
      ['company', 'Bharat Forge'],
    ]);
    const back = await asCeo
      .post(`/api/bundles/${bundle.id}/members`)
      .send({ contactIds: [found[0].contactId] });
    expect(back.body.data).toEqual({ added: 1, memberCount: 2 });
    const company = await asCeo
      .post(`/api/bundles/${bundle.id}/members`)
      .send({ accountIds: [forge.account.id], includePeople: false });
    expect(company.body.data.memberCount).toBe(3);

    expect((await asCeo.get('/api/bundles')).body.data).toMatchObject([
      { name: 'Forge people', memberCount: 3, createdBy: 'Kunal CEO' },
    ]);
    expect((await asCeo.delete(`/api/bundles/${bundle.id}`)).status).toBe(200);
    expect((await asCeo.get(`/api/bundles/${bundle.id}`)).status).toBe(404);
  });

  it('hold only what their maker may see, and are seen by their maker and the line above', async () => {
    // The manager sees every company (by the roles); a sales agent has no bulk sending at all.
    expect((await asAgent.get('/api/bundles')).status).toBe(403);
    const mine = await asManager
      .post('/api/bundles')
      .send({ name: 'Mine', accountIds: [forge.account.id] });
    expect(mine.body.data.memberCount).toBe(3);
    expect((await asCeo.get(`/api/bundles/${mine.body.data.id}`)).status).toBe(200);
    // A bundle of the CEO is not the manager's to see.
    const ceos = await asCeo.post('/api/bundles').send({ name: 'CEO only' });
    expect((await asManager.get(`/api/bundles/${ceos.body.data.id}`)).status).toBe(404);
    expect((await asManager.get('/api/bundles')).body.data.map((item) => item.name)).toEqual([
      'Mine',
    ]);
  });
});

describe('many companies at once', () => {
  it('"select all" gets the ids of every company the filters match', async () => {
    const all = (await asCeo.get('/api/accounts/ids')).body.data;
    expect(all).toMatchObject({ total: 2, isCut: false });
    expect([...all.ids].sort()).toEqual([forge.account.id, works.account.id].sort());
    expect((await asCeo.get('/api/accounts/ids?search=shakti')).body.data.ids).toEqual([
      works.account.id,
    ]);
    // An agent gets only their own companies.
    expect((await asAgent.get('/api/accounts/ids')).body.data.ids).toEqual([]);
  });

  it('are given to people in turns, also companies that have an owner', async () => {
    // Bharat Forge belongs to the CEO, who made it. Three more have nobody.
    const free = [];
    for (const name of ['Free One', 'Free Two', 'Free Three']) {
      const made = await asCeo.post('/api/accounts').send({ name });
      expect(made.status).toBe(201);
      free.push(made.body.data.id);
    }
    // As after an import or an inbound lead: nobody owns them yet.
    await Account.updateMany({ _id: { $in: free } }, { $unset: { ownerId: 1 } });
    const accountIds = [forge.account.id, ...free];

    const result = await asCeo
      .post('/api/accounts/bulk/assign')
      .send({ accountIds, userIds: [agentId, managerId] });
    expect(result.status).toBe(200);
    // Founder, 2026-10-31: a company with an owner gets the new one too.
    expect(result.body.data).toMatchObject({
      assigned: 4,
      skipped: 0,
      failed: [],
      perUser: [
        { name: 'Asha Agent', count: 2 },
        { name: 'Mira Manager', count: 2 },
      ],
    });
    const owners = await Account.find({ _id: { $in: accountIds } })
      .sort({ createdAt: 1, _id: 1 })
      .lean();
    expect(owners.map((item) => String(item.ownerId))).toEqual([
      agentId,
      managerId,
      agentId,
      managerId,
    ]);

    // All to the manager: the two that are hers already are skipped, the others move.
    const again = await asCeo
      .post('/api/accounts/bulk/assign')
      .send({ accountIds, userIds: [managerId] });
    expect(again.body.data).toMatchObject({ assigned: 2, skipped: 2 });
    expect(
      (await Account.find({ _id: { $in: accountIds } }).lean()).every(
        (item) => String(item.ownerId) === managerId,
      ),
    ).toBe(true);
    expect(
      (await asAgent.post('/api/accounts/bulk/assign').send({ accountIds, userIds: [agentId] }))
        .status,
    ).toBe(403);
    expect(
      (await asCeo.post('/api/accounts/bulk/assign').send({ accountIds, userIds: [] })).status,
    ).toBe(400);
  });

  it('are taken out as a file with the main person of each', async () => {
    const file = await asCeo
      .post('/api/accounts/bulk/export')
      .send({ accountIds: [forge.account.id, works.account.id] });
    expect(file.status).toBe(200);
    expect(file.headers['content-disposition']).toMatch(/selected-accounts-.*\.csv/);
    const [head, first, second] = file.text.trim().split(/\r?\n/);
    expect(head).toContain(
      'Company name,Industry,City,State,Status,Owner,Company phone,Company email',
    );
    expect(head).toContain('Main contact,Designation,Contact phone,Contact email');
    expect(first).toContain('Bharat Forge');
    expect(first).toContain('Asha Verma');
    expect(first).toContain('asha.verma@bharatforge.example');
    expect(second).toContain('Shakti Works');
    expect(file.text).not.toMatch(/gstin|pan\b/i);
    expect(
      (await asAgent.post('/api/accounts/bulk/export').send({ accountIds: [forge.account.id] }))
        .status,
    ).toBe(403);
  });
});
