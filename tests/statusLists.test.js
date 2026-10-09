import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { normalizePhone } from '../lib/phone.js';
import { CODE_SERIES, nextCode } from '../lib/sequence.js';
import { createSessionMiddleware } from '../middleware/session.js';
import { Account } from '../models/account.model.js';
import { AuditLog } from '../models/auditLog.model.js';
import { Role } from '../models/role.model.js';
import { AccountStatus, LeadStatus } from '../models/statusLists.model.js';
import { User } from '../models/user.model.js';
import { runSeed, seedStatusLists } from '../seeds/seed.js';
import { clearTestDb, startTestDb, stopTestDb } from './helpers/testDb.js';

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

const namesOf = (response) => response.body.data.map((status) => status.name);

beforeAll(async () => {
  await startTestDb();
  app = createApp({ sessionMiddleware: createSessionMiddleware() });
});
afterAll(stopTestDb);

beforeEach(async () => {
  await clearTestDb();
  await runSeed({ productName: 'P', companyName: 'C', workspaceDomain: 'engenx.in' });
  await seedStatusLists();
  const roles = Object.fromEntries((await Role.find()).map((role) => [role.name, role]));
  const makeUser = (email, name, roleName) =>
    User.create({ email, name, roleId: roles[roleName]._id, status: 'active', password: PASSWORD });
  ceo = await makeUser('ceo@engenx.in', 'Kunal CEO', 'CEO');
  manager = await makeUser('manager@engenx.in', 'Meera Manager', 'Sales Manager');
  agent = await makeUser('agent@engenx.in', 'Asha Agent', 'Sales Agent');
  await AuditLog.deleteMany({});
});

describe('seeded status lists', () => {
  it('account statuses: six, Prospect first and default', async () => {
    const response = await (await signedInAs(agent)).get('/api/status-lists/account-statuses');
    expect(response.status).toBe(200);
    expect(namesOf(response)).toEqual([
      'Prospect',
      'Active',
      'Customer',
      'Dormant',
      'Lost',
      'Strategic',
    ]);
    expect(response.body.data.filter((status) => status.isDefault).map((s) => s.key)).toEqual([
      'prospect',
    ]);
  });

  it("lead statuses: the founder's sixteen, in order, New Lead default", async () => {
    const response = await (await signedInAs(agent)).get('/api/status-lists/lead-statuses');
    expect(namesOf(response)).toEqual([
      'New Lead',
      'Connected',
      'Contact Attempt 1',
      'Contacted',
      'Meeting Scheduled',
      'Demo Scheduled',
      'Proposal Shared',
      'Negotiation',
      'Interested',
      'Follow-up',
      'Won',
      'Lost',
      'Future Opportunity',
      'DNP',
      'NATC',
      'Not interested',
    ]);
    const byName = Object.fromEntries(response.body.data.map((status) => [status.name, status]));
    expect(byName['New Lead']).toMatchObject({ key: 'new_lead', isDefault: true, isActive: true });
    expect(byName['Contact Attempt 1'].key).toBe('contact_attempt_1');
    expect(byName['Follow-up'].key).toBe('follow_up');
  });

  it('seeding again adds nothing and never brings back a deleted status', async () => {
    await LeadStatus.deleteOne({ key: 'natc' });
    expect(await seedStatusLists()).toEqual({ accountStatusesCreated: 0, leadStatusesCreated: 0 });
    expect(await LeadStatus.countDocuments()).toBe(15);
  });
});

describe('managing a status list in Settings', () => {
  const base = '/api/status-lists/lead-statuses';

  it('reading needs a session; changing needs the settings permission', async () => {
    expect((await request(app).get(base)).status).toBe(401);
    const status = await LeadStatus.findOne({ key: 'dnp' }).lean();
    for (const user of [manager, agent]) {
      const client = await signedInAs(user);
      expect((await client.get(base)).status).toBe(200);
      expect((await client.post(base).send({ name: 'Hacked' })).status).toBe(403);
      expect((await client.patch(`${base}/${status._id}`).send({ name: 'X' })).status).toBe(403);
      expect((await client.delete(`${base}/${status._id}`)).status).toBe(403);
      expect((await client.put(`${base}/order`).send({ ids: [String(status._id)] })).status).toBe(
        403,
      );
    }
    expect(await LeadStatus.countDocuments()).toBe(16);
  });

  it('adds a status at the end with its own fixed key', async () => {
    const client = await signedInAs(ceo);
    const created = await client.post(base).send({ name: '  Site Visit Done ', color: 'success' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      name: 'Site Visit Done',
      key: 'site_visit_done',
      color: 'success',
      isActive: true,
      isDefault: false,
    });
    expect(namesOf(await client.get(base)).at(-1)).toBe('Site Visit Done');
    expect((await AuditLog.findOne({ action: 'status.created' }).lean()).entityType).toBe(
      'lead_statuses',
    );
  });

  it('refuses a name that exists already, in any letter case', async () => {
    const client = await signedInAs(ceo);
    for (const name of ['Won', 'won', ' WON ']) {
      expect((await client.post(base).send({ name })).status, name).toBe(409);
    }
    const dnp = await LeadStatus.findOne({ key: 'dnp' }).lean();
    expect((await client.patch(`${base}/${dnp._id}`).send({ name: 'natc' })).status).toBe(409);
    // A name that only contains another one is fine.
    expect((await client.post(base).send({ name: 'Won back' })).status).toBe(201);
  });

  it('renaming keeps the key, and the new name shows at once', async () => {
    const client = await signedInAs(ceo);
    const dnp = await LeadStatus.findOne({ key: 'dnp' }).lean();
    const renamed = await client.patch(`${base}/${dnp._id}`).send({ name: 'Did Not Pick' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data).toMatchObject({ name: 'Did Not Pick', key: 'dnp' });
    // The old name is free again; its key is not reused.
    const again = await client.post(base).send({ name: 'DNP' });
    expect(again.status).toBe(201);
    expect(again.body.data.key).toBe('dnp_2');
  });

  it('keeps exactly one default, which cannot be switched off or deleted', async () => {
    const client = await signedInAs(ceo);
    const newLead = await LeadStatus.findOne({ key: 'new_lead' }).lean();
    const connected = await LeadStatus.findOne({ key: 'connected' }).lean();

    expect((await client.patch(`${base}/${newLead._id}`).send({ isActive: false })).status).toBe(
      409,
    );
    expect((await client.delete(`${base}/${newLead._id}`)).status).toBe(409);

    expect((await client.patch(`${base}/${connected._id}`).send({ isDefault: true })).status).toBe(
      200,
    );
    const defaults = await LeadStatus.find({ isDefault: true }).lean();
    expect(defaults.map((status) => status.key)).toEqual(['connected']);

    // The old default is now an ordinary status.
    expect((await client.patch(`${base}/${newLead._id}`).send({ isActive: false })).status).toBe(
      200,
    );
    // "isDefault: false" is not a thing: another status is made the default instead.
    expect((await client.patch(`${base}/${connected._id}`).send({ isDefault: false })).status).toBe(
      400,
    );
    // An inactive status cannot become the default.
    expect((await client.patch(`${base}/${newLead._id}`).send({ isDefault: true })).status).toBe(
      409,
    );
  });

  it('reorders the whole list, and refuses a partial or wrong list of ids', async () => {
    const client = await signedInAs(ceo);
    const ids = (await client.get(base)).body.data.map((status) => status.id);
    const reversed = [...ids].reverse();
    const response = await client.put(`${base}/order`).send({ ids: reversed });
    expect(response.status).toBe(200);
    expect(response.body.data.map((status) => status.id)).toEqual(reversed);
    expect(namesOf(await client.get(base))[0]).toBe('Not interested');

    for (const bad of [
      ids.slice(1),
      [...ids.slice(1), ids[1]],
      [...ids, '0123456789abcdef01234567'],
    ]) {
      expect((await client.put(`${base}/order`).send({ ids: bad })).status).toBe(400);
    }
  });

  it('rejects bad input and unknown lists', async () => {
    const client = await signedInAs(ceo);
    expect((await client.get('/api/status-lists/passwords')).status).toBe(400);
    expect((await client.post(base).send({ name: '' })).status).toBe(400);
    expect((await client.post(base).send({ name: 'x'.repeat(61) })).status).toBe(400);
    expect((await client.post(base).send({ name: 'Ok', color: '#ff0000' })).status).toBe(400);
    expect((await client.patch(`${base}/not-an-id`).send({ name: 'X' })).status).toBe(400);
    expect(
      (await client.patch(`${base}/0123456789abcdef01234567`).send({ name: 'X' })).status,
    ).toBe(404);
    expect((await client.delete(`${base}/0123456789abcdef01234567`)).status).toBe(404);
  });
});

describe('account statuses and the accounts that use them', () => {
  const base = '/api/status-lists/account-statuses';
  let customer;
  beforeEach(async () => {
    customer = await AccountStatus.findOne({ key: 'customer' }).lean();
  });

  it('a new account gets the default status; a chosen one is used when given', async () => {
    const client = await signedInAs(ceo);
    const first = await client.post('/api/accounts').send({ name: 'First Co' });
    expect(first.body.data.status).toMatchObject({ key: 'prospect', name: 'Prospect' });
    const second = await client
      .post('/api/accounts')
      .send({ name: 'Second Co', statusId: String(customer._id) });
    expect(second.body.data.status.key).toBe('customer');
  });

  it('a rename shows on every account at once, because the account stores only the id', async () => {
    const client = await signedInAs(ceo);
    const account = await client
      .post('/api/accounts')
      .send({ name: 'Rename Co', statusId: String(customer._id) });
    await client.patch(`${base}/${customer._id}`).send({ name: 'Paying Customer' });

    const detail = await client.get(`/api/accounts/${account.body.data.id}`);
    expect(detail.body.data.status).toMatchObject({ name: 'Paying Customer', key: 'customer' });
    const list = await client.get('/api/accounts');
    expect(list.body.data[0].status.name).toBe('Paying Customer');
  });

  it('a status in use cannot be deleted; switched off it leaves the pickers but stays on its accounts', async () => {
    const client = await signedInAs(ceo);
    const account = await client
      .post('/api/accounts')
      .send({ name: 'Used Co', statusId: String(customer._id) });

    const refused = await client.delete(`${base}/${customer._id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/1 record has this account status/);

    expect((await client.patch(`${base}/${customer._id}`).send({ isActive: false })).status).toBe(
      200,
    );
    // Still shown on the account that has it …
    const detail = await client.get(`/api/accounts/${account.body.data.id}`);
    expect(detail.body.data.status.key).toBe('customer');
    // … but it cannot be chosen any more, on create or on edit.
    const create = await client
      .post('/api/accounts')
      .send({ name: 'Another Co', statusId: String(customer._id) });
    expect(create.status).toBe(400);
    expect(create.body.error.details[0].field).toBe('statusId');
    const other = await client.post('/api/accounts').send({ name: 'Third Co' });
    expect(
      (
        await client
          .patch(`/api/accounts/${other.body.data.id}`)
          .send({ statusId: String(customer._id) })
      ).status,
    ).toBe(400);

    // An unused status can be deleted.
    const dormant = await AccountStatus.findOne({ key: 'dormant' }).lean();
    expect((await client.delete(`${base}/${dormant._id}`)).status).toBe(200);
    expect(await AccountStatus.countDocuments()).toBe(5);
  });

  it('with no status at all, creating an account says what to do instead of failing oddly', async () => {
    await AccountStatus.deleteMany({});
    const response = await (
      await signedInAs(ceo)
    )
      .post('/api/accounts')
      .send({ name: 'No Status Co' });
    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/Settings/);
    expect(await Account.countDocuments()).toBe(0);
  });
});

describe('account codes', () => {
  it('run in a series from EGX-10001, and a lead series is separate', async () => {
    expect(await nextCode(CODE_SERIES.account)).toBe('EGX-10001');
    expect(await nextCode(CODE_SERIES.account)).toBe('EGX-10002');
    expect(await nextCode(CODE_SERIES.lead)).toBe('EGL-10001');
    expect(await nextCode(CODE_SERIES.account)).toBe('EGX-10003');
  });

  it('many accounts created at the same moment all get different codes', async () => {
    const client = await signedInAs(ceo);
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, number) =>
        client.post('/api/accounts').send({ name: `Parallel Company ${number}` }),
      ),
    );
    expect(responses.every((response) => response.status === 201)).toBe(true);
    const codes = responses.map((response) => response.body.data.accountCode).sort();
    expect(new Set(codes).size).toBe(12);
    expect(codes[0]).toBe('EGX-10001');
    expect(codes.at(-1)).toBe('EGX-10012');
  });

  it('a refused request uses up no code, a deleted account keeps its code, and the code cannot be changed', async () => {
    const client = await signedInAs(ceo);
    const first = await client.post('/api/accounts').send({ name: 'Code Co' });
    expect(first.body.data.accountCode).toBe('EGX-10001');
    expect((await client.post('/api/accounts').send({ name: 'Code Co' })).status).toBe(409); // duplicate
    expect((await client.post('/api/accounts').send({ name: '' })).status).toBe(400);

    await client.delete(`/api/accounts/${first.body.data.id}`);
    const second = await client.post('/api/accounts').send({ name: 'Next Co' });
    expect(second.body.data.accountCode).toBe('EGX-10002'); // 10001 is never used again

    // Sending a code is ignored: it is not a field a person can set.
    await client
      .patch(`/api/accounts/${second.body.data.id}`)
      .send({ accountCode: 'EGX-1', region: 'West' });
    expect((await Account.findById(second.body.data.id).lean()).accountCode).toBe('EGX-10002');
  });

  it('an account is found by its code in the search', async () => {
    const client = await signedInAs(ceo);
    await client.post('/api/accounts').send({ name: 'Alpha' });
    await client.post('/api/accounts').send({ name: 'Beta' });
    const found = await client.get('/api/accounts?search=EGX-10002');
    expect(found.body.data.map((account) => account.name)).toEqual(['Beta']);
    expect(
      (await client.get('/api/accounts?sort=accountCode')).body.data.map((a) => a.name),
    ).toEqual(['Alpha', 'Beta']);
  });
});

describe('new account fields', () => {
  it('stores the phone in one form however it is typed', () => {
    for (const typed of [
      '98765 43210',
      '09876543210',
      '919876543210',
      '+91-98765-43210',
      '0091 98765 43210',
    ]) {
      expect(normalizePhone(typed), typed).toBe('+919876543210');
    }
    expect(normalizePhone('020 2612 3456')).toBe('+912026123456'); // landline with its area code
    expect(normalizePhone('+1 (415) 555-0100')).toBe('+14155550100');
    for (const bad of ['', null, '12345', 'call me', '2612 3456', '+0123']) {
      expect(normalizePhone(bad), String(bad)).toBeNull();
    }
  });

  it('saves phone, email, LinkedIn, description, source detail and a parent company', async () => {
    const client = await signedInAs(ceo);
    const group = await client.post('/api/accounts').send({ name: 'Kalyani Group' });
    const response = await client.post('/api/accounts').send({
      name: 'Bharat Forge',
      phone: '020-2670 2777',
      email: ' Info@BharatForge.com ',
      linkedinUrl: 'linkedin.com/company/bharat-forge',
      description: 'Forging company in Pune.',
      parentAccountId: group.body.data.id,
      sourceDetail: { campaign: 'Digital Twin Q3', form: 'Demo request' },
    });
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      phone: '+912026702777',
      email: 'info@bharatforge.com',
      linkedinUrl: 'https://linkedin.com/company/bharat-forge',
      description: 'Forging company in Pune.',
      parent: { id: group.body.data.id, name: 'Kalyani Group', accountCode: 'EGX-10001' },
      sourceDetail: { campaign: 'Digital Twin Q3', form: 'Demo request' },
    });

    const bad = await client.post('/api/accounts').send({
      name: 'Bad Fields',
      phone: '12345',
      email: 'not-an-email',
      linkedinUrl: 'https://example.com/company/x',
      description: 'x'.repeat(2001),
      parentAccountId: 'nope',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.map((detail) => detail.field).sort()).toEqual([
      'description',
      'email',
      'linkedinUrl',
      'parentAccountId',
      'phone',
    ]);
  });

  it('a parent must be another existing company and can never form a circle', async () => {
    const client = await signedInAs(ceo);
    const a = (await client.post('/api/accounts').send({ name: 'A Group' })).body.data;
    const b = (
      await client.post('/api/accounts').send({ name: 'B Limited', parentAccountId: a.id })
    ).body.data;
    const c = (await client.post('/api/accounts').send({ name: 'C Works', parentAccountId: b.id }))
      .body.data;
    const patch = (id, parentAccountId) =>
      client.patch(`/api/accounts/${id}`).send({ parentAccountId });

    expect((await patch(a.id, a.id)).status).toBe(400); // itself
    expect((await patch(a.id, b.id)).status).toBe(400); // its own child
    expect((await patch(a.id, c.id)).status).toBe(400); // its grandchild
    expect((await patch(a.id, '0123456789abcdef01234567')).status).toBe(400); // nobody
    expect((await Account.findById(a.id).lean()).parentAccountId).toBeUndefined();

    // The link can be removed, and the audit entry names the parent.
    expect((await patch(c.id, null)).status).toBe(200);
    const entry = await AuditLog.findOne({ action: 'account.updated' }).sort({ at: -1 }).lean();
    expect(entry.oldValue).toEqual({ parent: 'B Limited' });
    expect(entry.newValue).toEqual({ parent: null });

    // A company that others name as their parent cannot be deleted.
    const refused = await client.delete(`/api/accounts/${a.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/1 company names it as the parent/);
  });
});
