import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { createSessionMiddleware } from '../middleware/session.js';
import { Account } from '../models/account.model.js';
import { AuditLog } from '../models/auditLog.model.js';
import { Contact } from '../models/contact.model.js';
import { Role } from '../models/role.model.js';
import { User } from '../models/user.model.js';
import { runSeed, seedStatusLists } from '../seeds/seed.js';
import { clearTestDb, startTestDb, stopTestDb } from './helpers/testDb.js';

const PASSWORD = 'correct-horse-battery';
let app;
let ceo;
let agent;
let otherAgent;

async function signedInAs(user) {
  const client = request.agent(app);
  const response = await client
    .post('/api/auth/login')
    .send({ email: user.email, password: PASSWORD });
  expect(response.status).toBe(200);
  return client;
}

const form = (overrides = {}) => ({
  account: { name: 'Bharat Forge', industry: 'Forging', phone_number: '020 2670 2777' },
  contacts: [
    {
      name: 'Asha Verma',
      designation: 'Plant Head',
      phone_number: '98765 43210',
      email: ' Asha@BharatForge.com ',
      stakeholderRole: 'plant_head',
    },
    { name: 'Ravi Kumar', phone_number: '09123456780' },
  ],
  ...overrides,
});

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
  agent = await makeUser('agent@engenx.in', 'Asha Agent', 'Sales Agent');
  otherAgent = await makeUser('other@engenx.in', 'Omar Agent', 'Sales Agent');
  await AuditLog.deleteMany({});
});

describe('quick add: a company and its people from one form', () => {
  it('needs a session and the permission to create accounts', async () => {
    expect((await request(app).post('/api/accounts/quick-add').send(form())).status).toBe(401);
    await Role.updateOne(
      { name: 'Sales Agent' },
      { $pull: { grants: { feature: 'accounts', action: 'create' } } },
    );
    expect(
      (await (await signedInAs(agent)).post('/api/accounts/quick-add').send(form())).status,
    ).toBe(403);
    expect(await Account.countDocuments()).toBe(0);
  });

  it('creates the company with its code and its people, and records who filled the form', async () => {
    const client = await signedInAs(agent);
    const response = await client.post('/api/accounts/quick-add').send(form());
    expect(response.status).toBe(201);

    const { account, contacts } = response.body.data;
    expect(account).toMatchObject({
      accountCode: 'EGX-10001',
      name: 'Bharat Forge',
      phone_number: '+912026702777',
      status: { key: 'prospect' },
      owner: { id: String(agent._id) },
      formFilledBy: { id: String(agent._id), name: 'Asha Agent' },
    });
    expect(contacts).toHaveLength(2);
    expect(contacts[0]).toMatchObject({
      accountId: account.id,
      name: 'Asha Verma',
      designation: 'Plant Head',
      phone_number: '+919876543210',
      email: 'asha@bharatforge.com',
      stakeholderRole: 'plant_head',
      formFilledBy: { id: String(agent._id), name: 'Asha Agent' },
      // Nobody is assumed to have agreed to messages or calls.
      consent: { whatsappOptIn: false, doNotCall: false },
    });
    expect(contacts[1]).toMatchObject({ name: 'Ravi Kumar', phone_number: '+919123456780' });

    // In the database: the user's _id under formFilledBy, on the account and on each person.
    const storedAccount = await Account.findById(account.id).lean();
    expect(String(storedAccount.formFilledBy)).toBe(String(agent._id));
    const storedContacts = await Contact.find({ accountId: account.id }).lean();
    expect(storedContacts.map((contact) => String(contact.formFilledBy))).toEqual([
      String(agent._id),
      String(agent._id),
    ]);
    expect(storedContacts.every((contact) => contact.source === 'manual')).toBe(true);

    const actions = (await AuditLog.find().lean()).map((entry) => entry.action).sort();
    expect(actions).toEqual(['account.created', 'contact.created', 'contact.created']);
  });

  it('works with a company alone, and the plain "new account" form records who filled it too', async () => {
    const client = await signedInAs(ceo);
    const alone = await client
      .post('/api/accounts/quick-add')
      .send({ account: { name: 'Solo Co' } });
    expect(alone.status).toBe(201);
    expect(alone.body.data.contacts).toEqual([]);

    const plain = await client.post('/api/accounts').send({ name: 'Plain Co' });
    expect(plain.body.data.formFilledBy).toMatchObject({ id: String(ceo._id), name: 'Kunal CEO' });
  });

  it('warns about a similar company name before anything is saved, then saves after confirmation', async () => {
    const client = await signedInAs(ceo);
    await client.post('/api/accounts').send({ name: 'Bharat Forge Ltd' });
    const warned = await client.post('/api/accounts/quick-add').send(form());
    expect(warned.status).toBe(409);
    expect(warned.body.error.details[0].code).toBe('DUPLICATE_NAME');
    expect(await Contact.countDocuments()).toBe(0);

    const confirmed = await client
      .post('/api/accounts/quick-add')
      .send(form({ account: { name: 'Bharat Forge', confirmDuplicate: true } }));
    expect(confirmed.status).toBe(201);
    expect(await Account.countDocuments()).toBe(2);
    expect(await Contact.countDocuments()).toBe(2);
  });

  it('rejects a bad form with one message per field and saves nothing', async () => {
    const client = await signedInAs(ceo);
    const response = await client.post('/api/accounts/quick-add').send({
      account: { name: '', phone_number: '123' },
      contacts: [
        { name: '', phone_number: 'abc', email: 'nope' },
        { name: 'Fine Person', stakeholderRole: 'boss' },
      ],
    });
    expect(response.status).toBe(400);
    expect(response.body.error.details.map((detail) => detail.field).sort()).toEqual([
      'account.name',
      'account.phone_number',
      'contacts.0.email',
      'contacts.0.name',
      'contacts.0.phone_number',
      'contacts.1.stakeholderRole',
    ]);
    const tooMany = form({
      contacts: Array.from({ length: 11 }, (_, number) => ({ name: `Person ${number}` })),
    });
    expect((await client.post('/api/accounts/quick-add').send(tooMany)).status).toBe(400);
    expect(await Account.countDocuments()).toBe(0);
    expect(await Contact.countDocuments()).toBe(0);
  });

  it('when the people cannot be saved, the company is not left behind', async () => {
    const client = await signedInAs(ceo);
    // The same number for two people: refused after the company step.
    const response = await client.post('/api/accounts/quick-add').send(
      form({
        contacts: [
          { name: 'One', phone_number: '9876543210' },
          { name: 'Two', phone_number: '+91 98765 43210' },
        ],
      }),
    );
    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/more than one person/);
    expect(await Account.countDocuments()).toBe(0);
    expect(await Contact.countDocuments()).toBe(0);

    // The corrected form goes through without a "similar name" warning about itself.
    const fixed = await client.post('/api/accounts/quick-add').send(form());
    expect(fixed.status).toBe(201);
    expect(fixed.body.data.account.accountCode).toBe('EGX-10002'); // the first code is not reused
  });

  it('someone who may not add contacts gets a clear refusal and no half-saved company', async () => {
    await Role.updateOne(
      { name: 'Sales Agent' },
      { $pull: { grants: { feature: 'contacts', action: 'create' } } },
    );
    const client = await signedInAs(agent);
    const response = await client.post('/api/accounts/quick-add').send(form());
    expect(response.status).toBe(403);
    expect(await Account.countDocuments()).toBe(0);
    // Without people the same form still works.
    expect(
      (await client.post('/api/accounts/quick-add').send({ account: { name: 'Solo' } })).status,
    ).toBe(201);
  });
});

describe('the people of an account', () => {
  let accountId;
  beforeEach(async () => {
    const client = await signedInAs(agent);
    accountId = (await client.post('/api/accounts/quick-add').send(form())).body.data.account.id;
  });

  it('are listed by name for someone who may see the account, and hidden from everyone else', async () => {
    const mine = await (await signedInAs(agent)).get(`/api/accounts/${accountId}/contacts`);
    expect(mine.status).toBe(200);
    expect(mine.body.data.map((contact) => contact.name)).toEqual(['Asha Verma', 'Ravi Kumar']);

    // Another agent cannot see the account, so not its people either, by list or by adding.
    const other = await signedInAs(otherAgent);
    expect((await other.get(`/api/accounts/${accountId}/contacts`)).status).toBe(404);
    expect(
      (await other.post(`/api/accounts/${accountId}/contacts`).send({ name: 'Spy' })).status,
    ).toBe(404);
    expect((await request(app).get(`/api/accounts/${accountId}/contacts`)).status).toBe(401);
  });

  it('one more person can be added; the same phone or email in the same company is refused', async () => {
    const client = await signedInAs(agent);
    const added = await client
      .post(`/api/accounts/${accountId}/contacts`)
      .send({ name: 'Meena Shah', email: 'meena@bharatforge.com' });
    expect(added.status).toBe(201);
    expect(added.body.data.formFilledBy.name).toBe('Asha Agent');

    for (const body of [
      { name: 'Asha Again', phone_number: '+91 98765-43210' },
      { name: 'Asha Again', alt_phone_number: '9876543210' },
      { name: 'Meena Again', email: 'MEENA@bharatforge.com' },
    ]) {
      const response = await client.post(`/api/accounts/${accountId}/contacts`).send(body);
      expect(response.status, JSON.stringify(body)).toBe(409);
    }
    expect(await Contact.countDocuments()).toBe(3);
    // The same number at ANOTHER company is fine (a consultant, a group head).
    const second = await client.post('/api/accounts').send({ name: 'Second Co' });
    expect(
      (
        await client
          .post(`/api/accounts/${second.body.data.id}/contacts`)
          .send({ name: 'Asha V', phone_number: '9876543210' })
      ).status,
    ).toBe(201);
  });

  it('deleting the company hides its people with it', async () => {
    const asCeo = await signedInAs(ceo);
    expect((await asCeo.delete(`/api/accounts/${accountId}`)).status).toBe(200);
    expect((await asCeo.get(`/api/accounts/${accountId}/contacts`)).status).toBe(404);
    const stored = await Contact.find({ accountId }).lean();
    expect(stored).toHaveLength(2); // kept in the database …
    expect(stored.every((contact) => contact.deletedAt instanceof Date)).toBe(true); // … but hidden
  });
});
