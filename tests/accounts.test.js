import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { toNameKey } from '../lib/nameKey.js';
import { createSessionMiddleware } from '../middleware/session.js';
import { Account } from '../models/account.model.js';
import { AuditLog } from '../models/auditLog.model.js';
import { Role } from '../models/role.model.js';
import { User } from '../models/user.model.js';
import { AccountStatus } from '../models/statusLists.model.js';
import { runSeed, seedStatusLists } from '../seeds/seed.js';
import { maskSensitive, registerAccountDeleteBlocker } from '../services/accounts.service.js';
import { clearTestDb, startTestDb, stopTestDb } from './helpers/testDb.js';

const PASSWORD = 'correct-horse-battery';
const GSTIN = '27ABCDE1234F1Z5';
const PAN = 'ABCDE1234F';
let app;
let ceo;
let manager;
let agent;
let otherAgent;
// The seeded account statuses by key: statuses.prospect, statuses.customer, …
let statuses;

async function signedInAs(user) {
  const client = request.agent(app);
  const response = await client
    .post('/api/auth/login')
    .send({ email: user.email, password: PASSWORD });
  expect(response.status).toBe(200);
  return client;
}

/** Put an account straight into the database, owned by `owner`. */
// (The API gives real codes; these direct inserts use their own series so they never clash.)
let testCode = 0;
const makeAccount = (name, owner, extra = {}) =>
  Account.create({
    name,
    accountCode: `TEST-${(testCode += 1)}`,
    nameKey: toNameKey(name),
    ownerId: owner._id,
    statusId: statuses.prospect._id,
    ...extra,
  });

const namesOf = (response) => response.body.data.map((account) => account.name).sort();

beforeAll(async () => {
  await startTestDb();
  app = createApp({ sessionMiddleware: createSessionMiddleware() });
});
afterAll(stopTestDb);

beforeEach(async () => {
  await clearTestDb();
  await runSeed({ productName: 'P', companyName: 'C', workspaceDomain: 'engenx.in' });
  await seedStatusLists();
  statuses = Object.fromEntries((await AccountStatus.find().lean()).map((s) => [s.key, s]));
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
  agent = await makeUser('agent@engenx.in', 'Asha Agent', 'Sales Agent', {
    managerId: manager._id,
  });
  otherAgent = await makeUser('other@engenx.in', 'Omar Agent', 'Sales Agent');
  await AuditLog.deleteMany({});
});

describe('company name matching', () => {
  it('treats spelling variants of one company as the same', () => {
    const key = toNameKey('Tata Steel Ltd.');
    for (const variant of [
      'TATA STEEL LIMITED',
      ' tata  steel ',
      'Tata Steel Pvt. Ltd',
      'Tata-Steel',
    ]) {
      expect(toNameKey(variant), variant).toBe(key);
    }
    expect(toNameKey('L&T')).toBe(toNameKey('L and T'));
    expect(toNameKey('Tata Steel')).not.toBe(toNameKey('Tata Motors'));
    // A name made only of legal-form words is kept, not emptied.
    expect(toNameKey('The Company')).not.toBe('');
  });
});

describe('who can see which account', () => {
  beforeEach(async () => {
    await makeAccount('Agent Owned', agent);
    await makeAccount('Assigned To Agent', otherAgent, { assignedUserIds: [agent._id] });
    await makeAccount('Other Agent Only', otherAgent);
    await makeAccount('CEO Owned', ceo);
    await makeAccount('Deleted One', agent, { deletedAt: new Date() });
  });

  it('needs a session', async () => {
    expect((await request(app).get('/api/accounts')).status).toBe(401);
    expect((await request(app).post('/api/accounts').send({ name: 'X' })).status).toBe(401);
  });

  it('the CEO and a Sales Manager see every account; a deleted one is hidden from everyone', async () => {
    const all = ['Agent Owned', 'Assigned To Agent', 'CEO Owned', 'Other Agent Only'];
    expect(namesOf(await (await signedInAs(ceo)).get('/api/accounts'))).toEqual(all);
    expect(namesOf(await (await signedInAs(manager)).get('/api/accounts'))).toEqual(all);
  });

  it('a Sales Agent sees only accounts they own or are assigned to, also when searching', async () => {
    const client = await signedInAs(agent);
    expect(namesOf(await client.get('/api/accounts'))).toEqual([
      'Agent Owned',
      'Assigned To Agent',
    ]);
    expect(namesOf(await client.get('/api/accounts?search=agent'))).toEqual([
      'Agent Owned',
      'Assigned To Agent',
    ]);
    expect(namesOf(await client.get('/api/accounts?search=ceo'))).toEqual([]);
    expect((await client.get('/api/accounts')).body.meta.total).toBe(2);
    // Asking for another owner's accounts does not open them.
    expect(namesOf(await client.get(`/api/accounts?ownerId=${ceo._id}`))).toEqual([]);
  });

  it('an agent cannot open, change or delete an account outside their scope by its id: 404', async () => {
    const hidden = await Account.findOne({ name: 'Other Agent Only' }).lean();
    const deleted = await Account.findOne({ name: 'Deleted One' }).lean();
    const client = await signedInAs(agent);
    for (const id of [hidden._id, deleted._id, '0123456789abcdef01234567']) {
      expect((await client.get(`/api/accounts/${id}`)).status).toBe(404);
      expect((await client.patch(`/api/accounts/${id}`).send({ industry: 'Steel' })).status).toBe(
        404,
      );
    }
    expect((await Account.findById(hidden._id).lean()).industry).toBeUndefined();
    expect((await client.get('/api/accounts/not-an-id')).status).toBe(400);
  });

  it('an agent may edit their accounts but not delete them or change who owns them', async () => {
    const mine = await Account.findOne({ name: 'Agent Owned' }).lean();
    const client = await signedInAs(agent);
    expect(
      (await client.patch(`/api/accounts/${mine._id}`).send({ industry: 'Steel' })).status,
    ).toBe(200);
    expect((await client.delete(`/api/accounts/${mine._id}`)).status).toBe(403);
    expect(
      (await client.patch(`/api/accounts/${mine._id}`).send({ ownerId: String(ceo._id) })).status,
    ).toBe(403);
    expect(
      (await client.patch(`/api/accounts/${mine._id}`).send({ assignedUserIds: [String(ceo._id)] }))
        .status,
    ).toBe(403);
    const after = await Account.findById(mine._id).lean();
    expect(String(after.ownerId)).toBe(String(agent._id));
    expect(after.deletedAt).toBeNull();
  });

  it('the form options give the user list only to someone who may assign', async () => {
    const forAgent = (await (await signedInAs(agent)).get('/api/accounts/form-options')).body.data;
    expect(forAgent.canAssign).toBe(false);
    expect(forAgent.users.map((user) => user.name)).toEqual(['Asha Agent']);

    const forManager = (await (await signedInAs(manager)).get('/api/accounts/form-options')).body
      .data;
    expect(forManager.canAssign).toBe(true);
    expect(forManager.users).toHaveLength(4);
    expect(forManager.statuses.map((status) => status.key)).toContain('prospect');
    expect(forManager.statuses.find((status) => status.isDefault).name).toBe('Prospect');
    expect(JSON.stringify(forManager)).not.toContain('engenx.in'); // names only, no emails
  });
});

describe('creating accounts', () => {
  it('an agent creates an account and becomes its owner', async () => {
    const client = await signedInAs(agent);
    const response = await client.post('/api/accounts').send({
      name: '  Bharat Forge Ltd ',
      industry: 'Forging',
      website: 'bharatforge.com',
      hq: { city: 'Pune', state: 'Maharashtra', country: 'India' },
      companySize: '5000+',
      annualRevenuePaise: 1_500_000_000_00,
      commercial: { accountPotential: 'high', strategicImportance: 4 },
      industrial: { existingPlc: 'Siemens', existingVendors: ['ABB', 'Rockwell'] },
    });
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      name: 'Bharat Forge Ltd',
      website: 'https://bharatforge.com',
      accountCode: 'EGX-10001',
      status: { key: 'prospect', name: 'Prospect' },
      source: 'manual',
      hq: { city: 'Pune' },
      owner: { id: String(agent._id), name: 'Asha Agent' },
      assignedUsers: [],
      permissions: { canEdit: true, canDelete: false, canAssign: false },
    });
    const stored = await Account.findOne({ name: 'Bharat Forge Ltd' }).lean();
    expect(stored.nameKey).toBe('bharatforge');
    expect(String(stored.createdBy)).toBe(String(agent._id));
    expect(stored.annualRevenuePaise).toBe(1_500_000_000_00);

    const entries = await AuditLog.find({ entityType: 'accounts' }).lean();
    expect(entries.map((entry) => entry.action)).toEqual(['account.created']);
  });

  it('only someone who may assign can name another owner or add people', async () => {
    const body = { name: 'Assigned Co', ownerId: String(otherAgent._id) };
    expect((await (await signedInAs(agent)).post('/api/accounts').send(body)).status).toBe(403);
    expect(
      (
        await (
          await signedInAs(agent)
        )
          .post('/api/accounts')
          .send({ name: 'X', assignedUserIds: [String(ceo._id)] })
      ).status,
    ).toBe(403);
    expect(await Account.countDocuments()).toBe(0);

    const created = await (
      await signedInAs(manager)
    )
      .post('/api/accounts')
      .send({ ...body, assignedUserIds: [String(agent._id), String(agent._id)] });
    expect(created.status).toBe(201);
    expect(created.body.data.owner.name).toBe('Omar Agent');
    expect(created.body.data.assignedUsers.map((user) => user.name)).toEqual(['Asha Agent']);
  });

  it('refuses an owner or assignee who is not an active user', async () => {
    await User.updateOne({ _id: otherAgent._id }, { $set: { status: 'deactivated' } });
    const client = await signedInAs(ceo);
    const response = await client
      .post('/api/accounts')
      .send({ name: 'X', ownerId: String(otherAgent._id) });
    expect(response.status).toBe(400);
    expect(response.body.error.details[0].field).toBe('ownerId');
    expect(
      (
        await client
          .post('/api/accounts')
          .send({ name: 'X', assignedUserIds: ['0123456789abcdef01234567'] })
      ).status,
    ).toBe(400);
  });

  it('warns about a company with a similar name, and creates it only after confirmation', async () => {
    const existing = await makeAccount('Tata Steel Ltd', otherAgent);
    const asCeo = await signedInAs(ceo);
    const conflict = await asCeo.post('/api/accounts').send({ name: 'TATA STEEL LIMITED' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.message).toContain('Tata Steel Ltd');
    expect(conflict.body.error.details[0]).toMatchObject({
      field: 'name',
      code: 'DUPLICATE_NAME',
      existingId: String(existing._id),
    });

    // An agent who may not open that account is warned too, but gets no link to it.
    const asAgent = await signedInAs(agent);
    const forAgent = await asAgent.post('/api/accounts').send({ name: 'Tata Steel' });
    expect(forAgent.status).toBe(409);
    expect(forAgent.body.error.details[0].existingId).toBeNull();

    const confirmed = await asAgent
      .post('/api/accounts')
      .send({ name: 'Tata Steel', confirmDuplicate: true });
    expect(confirmed.status).toBe(201);
    expect(await Account.countDocuments()).toBe(2);
  });

  it('a deleted account does not count as a duplicate', async () => {
    await makeAccount('Old Co', ceo, { deletedAt: new Date() });
    expect(
      (await (await signedInAs(ceo)).post('/api/accounts').send({ name: 'Old Co' })).status,
    ).toBe(201);
  });

  it('rejects invalid input, one message per field', async () => {
    const client = await signedInAs(ceo);
    const response = await client.post('/api/accounts').send({
      name: '',
      statusId: 'unknown',
      companySize: 'huge',
      annualRevenuePaise: 10.5,
      gstin: '123',
      pan: 'ABC',
      website: 'not a website',
      commercial: { strategicImportance: 9 },
    });
    expect(response.status).toBe(400);
    const fields = response.body.error.details.map((detail) => detail.field).sort();
    expect(fields).toEqual([
      'annualRevenuePaise',
      'commercial.strategicImportance',
      'companySize',
      'gstin',
      'name',
      'pan',
      'statusId',
      'website',
    ]);
    expect(await Account.countDocuments()).toBe(0);
  });
});

describe('editing accounts', () => {
  let account;
  beforeEach(async () => {
    account = await makeAccount('Bharat Forge', agent, {
      industry: 'Forging',
      hq: { city: 'Pune', state: 'Maharashtra' },
      gstin: GSTIN,
      pan: PAN,
    });
    await makeAccount('Read Only For Agent', otherAgent);
  });

  it('merges small objects, clears a field with null, and records old and new values', async () => {
    const client = await signedInAs(agent);
    const response = await client.patch(`/api/accounts/${account._id}`).send({
      industry: null,
      region: 'West',
      hq: { city: 'Mumbai' },
      statusId: String(statuses.active._id),
    });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      industry: null,
      region: 'West',
      status: { key: 'active', name: 'Active' },
      hq: { city: 'Mumbai', state: 'Maharashtra' }, // state kept
    });
    const stored = await Account.findById(account._id).lean();
    expect(stored.industry).toBeUndefined();

    const entries = await AuditLog.find({ entityType: 'accounts' }).lean();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'account.updated',
      oldValue: {
        industry: 'Forging',
        status: 'Prospect',
        hq: { city: 'Pune', state: 'Maharashtra' },
      },
      // The status is recorded by name, so the log reads without a lookup.
      newValue: { industry: null, region: 'West', status: 'Active' },
    });
  });

  it('saving the same values changes nothing and writes no audit entry', async () => {
    const client = await signedInAs(agent);
    const response = await client
      .patch(`/api/accounts/${account._id}`)
      .send({ industry: 'Forging', hq: { city: 'Pune' } });
    expect(response.status).toBe(200);
    expect(await AuditLog.countDocuments()).toBe(0);
    expect((await client.patch(`/api/accounts/${account._id}`).send({})).status).toBe(400);
  });

  it('owner and assigned-people changes need the assign permission and get their own audit entries', async () => {
    const client = await signedInAs(manager);
    const response = await client.patch(`/api/accounts/${account._id}`).send({
      ownerId: String(otherAgent._id),
      assignedUserIds: [String(agent._id)],
      region: 'West',
    });
    expect(response.status).toBe(200);
    expect(response.body.data.owner.name).toBe('Omar Agent');
    expect(response.body.data.assignedUsers.map((user) => user.name)).toEqual(['Asha Agent']);

    const actions = (await AuditLog.find({ entityType: 'accounts' }).lean()).map(
      (entry) => entry.action,
    );
    expect(actions.sort()).toEqual([
      'account.assignment_changed',
      'account.owner_changed',
      'account.updated',
    ]);
    const ownerEntry = await AuditLog.findOne({ action: 'account.owner_changed' }).lean();
    expect(String(ownerEntry.oldValue.ownerId)).toBe(String(agent._id));
    expect(String(ownerEntry.newValue.ownerId)).toBe(String(otherAgent._id));

    // The first owner is now only assigned: still sees and edits it. Removed: it disappears.
    const asAgent = await signedInAs(agent);
    expect((await asAgent.get(`/api/accounts/${account._id}`)).status).toBe(200);
    await client.patch(`/api/accounts/${account._id}`).send({ assignedUserIds: [] });
    expect((await asAgent.get(`/api/accounts/${account._id}`)).status).toBe(404);
  });

  it('renaming checks for a duplicate, and keeps the comparable name in step', async () => {
    await makeAccount('Kirloskar Brothers', ceo);
    const client = await signedInAs(ceo);
    const clash = await client
      .patch(`/api/accounts/${account._id}`)
      .send({ name: 'Kirloskar Brothers Ltd' });
    expect(clash.status).toBe(409);

    // A different spelling of its own name is not a duplicate of itself.
    expect(
      (await client.patch(`/api/accounts/${account._id}`).send({ name: 'Bharat Forge Limited' }))
        .status,
    ).toBe(200);
    const renamed = await client
      .patch(`/api/accounts/${account._id}`)
      .send({ name: 'Kalyani Forge' });
    expect(renamed.status).toBe(200);
    expect((await Account.findById(account._id).lean()).nameKey).toBe('kalyaniforge');
  });

  it('GSTIN and PAN are shown in full only to someone who may edit the account, and never in a list or the audit log', async () => {
    // The agent owns it and may edit: full values.
    const owner = await (await signedInAs(agent)).get(`/api/accounts/${account._id}`);
    expect(owner.body.data).toMatchObject({ gstin: GSTIN, pan: PAN });

    // Take the edit permission away from Sales Agents: they still see the account, masked.
    await Role.updateOne(
      { name: 'Sales Agent' },
      { $pull: { grants: { feature: 'accounts', action: 'edit' } } },
    );
    const viewer = await (await signedInAs(agent)).get(`/api/accounts/${account._id}`);
    expect(viewer.status).toBe(200);
    expect(viewer.body.data.gstin).toBe(maskSensitive(GSTIN));
    expect(viewer.body.data.gstin.endsWith('1Z5')).toBe(true);
    expect(JSON.stringify(viewer.body)).not.toContain(GSTIN);
    expect(JSON.stringify(viewer.body)).not.toContain(PAN);
    expect(viewer.body.data.permissions.canEdit).toBe(false);

    const asCeo = await signedInAs(ceo);
    const list = await asCeo.get('/api/accounts');
    expect(JSON.stringify(list.body)).not.toContain(GSTIN);

    await asCeo.patch(`/api/accounts/${account._id}`).send({ gstin: '29ABCDE1234F1Z7', pan: null });
    const log = JSON.stringify(await AuditLog.find({ entityType: 'accounts' }).lean());
    expect(log).not.toContain(GSTIN);
    expect(log).not.toContain('29ABCDE1234F1Z7');
    expect(log).not.toContain(PAN);
    expect(log).toContain('1Z7'); // the masked tail, enough to recognise the change
  });

  it('sending the masked value back does not overwrite the real one', async () => {
    const client = await signedInAs(ceo);
    const response = await client
      .patch(`/api/accounts/${account._id}`)
      .send({ gstin: maskSensitive(GSTIN) });
    expect(response.status).toBe(400);
    expect((await Account.findById(account._id).lean()).gstin).toBe(GSTIN);
  });
});

describe('listing accounts', () => {
  beforeEach(async () => {
    await makeAccount('Alpha Steel', ceo, {
      industry: 'Steel',
      region: 'West',
      statusId: statuses.customer._id,
      hq: { city: 'Pune' },
    });
    await makeAccount('Beta Cement', agent, {
      industry: 'Cement',
      region: 'North',
      hq: { city: 'Delhi' },
    });
    await makeAccount('Gamma Steel', agent, {
      industry: 'Steel',
      region: 'North',
      statusId: statuses.active._id,
    });
  });

  it('filters, searches (also by city), sorts and pages on the server', async () => {
    const client = await signedInAs(ceo);
    const names = async (query) =>
      (await client.get(`/api/accounts?${query}`)).body.data.map((a) => a.name);

    expect(await names('sort=name')).toEqual(['Alpha Steel', 'Beta Cement', 'Gamma Steel']);
    expect(await names('sort=-name&pageSize=2')).toEqual(['Gamma Steel', 'Beta Cement']);
    expect(await names('sort=-name&pageSize=2&page=2')).toEqual(['Alpha Steel']);
    expect(await names('industry=Steel&sort=name')).toEqual(['Alpha Steel', 'Gamma Steel']);
    expect(await names('industry=Steel&region=North')).toEqual(['Gamma Steel']);
    expect(await names(`statusId=${statuses.customer._id}`)).toEqual(['Alpha Steel']);
    expect(await names(`ownerId=${agent._id}&sort=name`)).toEqual(['Beta Cement', 'Gamma Steel']);
    expect(await names('search=steel&sort=name')).toEqual(['Alpha Steel', 'Gamma Steel']);
    expect(await names('search=delhi')).toEqual(['Beta Cement']);
    expect(await names('range=today&sort=name')).toHaveLength(3);
    expect(await names('range=custom&from=2020-01-01&to=2020-01-31')).toEqual([]);

    const row = (await client.get('/api/accounts?search=alpha')).body.data[0];
    expect(row).toMatchObject({
      city: 'Pune',
      owner: { name: 'Kunal CEO' },
      status: { key: 'customer', name: 'Customer' },
    });
    for (const bad of ['sort=gstin', 'statusId=nope', 'pageSize=500', 'ownerId=x']) {
      expect((await client.get(`/api/accounts?${bad}`)).status, bad).toBe(400);
    }
  });

  it('the filter values offered come only from accounts the person may see', async () => {
    const forAgent = (await (await signedInAs(agent)).get('/api/accounts/form-options')).body.data;
    expect(forAgent.industries).toEqual(['Cement', 'Steel']);
    expect(forAgent.regions).toEqual(['North']); // "West" belongs to an account the agent cannot see
  });
});

describe('deleting accounts', () => {
  it('a manager soft-deletes: hidden everywhere, kept in the database, named in the audit log', async () => {
    const account = await makeAccount('Going Away', agent);
    const client = await signedInAs(manager);
    expect((await client.delete(`/api/accounts/${account._id}`)).status).toBe(200);

    expect((await client.get(`/api/accounts/${account._id}`)).status).toBe(404);
    expect(namesOf(await client.get('/api/accounts'))).toEqual([]);
    expect((await client.delete(`/api/accounts/${account._id}`)).status).toBe(404);
    const stored = await Account.findById(account._id).lean();
    expect(stored.deletedAt).toBeInstanceOf(Date);
    expect(String(stored.deletedBy)).toBe(String(manager._id));

    const log = await (await signedInAs(ceo)).get('/api/audit-logs?entityType=accounts');
    expect(log.body.data[0]).toMatchObject({ action: 'account.deleted', entityName: 'Going Away' });
  });

  it('is refused while something still depends on the account', async () => {
    const account = await makeAccount('Has Open Lead', ceo);
    // Stands in for the checks that the leads and invoices phases will add.
    const remove = registerAccountDeleteBlocker(async (accountId) =>
      String(accountId) === String(account._id) ? 'It has 2 open leads.' : null,
    );
    try {
      const client = await signedInAs(ceo);
      const response = await client.delete(`/api/accounts/${account._id}`);
      expect(response.status).toBe(409);
      expect(response.body.error.message).toContain('It has 2 open leads.');
      expect((await Account.findById(account._id).lean()).deletedAt).toBeNull();
    } finally {
      remove();
    }
    expect((await (await signedInAs(ceo)).delete(`/api/accounts/${account._id}`)).status).toBe(200);
  });
});
