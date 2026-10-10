import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { toCsv } from '../lib/csv.js';
import { createSessionMiddleware } from '../middleware/session.js';
import { Account } from '../models/account.model.js';
import { AuditLog } from '../models/auditLog.model.js';
import { Contact } from '../models/contact.model.js';
import { Machine } from '../models/machine.model.js';
import { Role } from '../models/role.model.js';
import { Tag } from '../models/tag.model.js';
import { User } from '../models/user.model.js';
import { runSeed, seedStartingLists, seedStatusLists } from '../seeds/seed.js';
import { clearTestDb, startTestDb, stopTestDb } from './helpers/testDb.js';

const PASSWORD = 'correct-horse-battery';
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

async function signedInAs(user) {
  const client = request.agent(app);
  const response = await client
    .post('/api/auth/login')
    .send({ email: user.email, password: PASSWORD });
  expect(response.status).toBe(200);
  return client;
}

const makeTag = async (name, extra = {}) =>
  (await asCeo.post('/api/tags').send({ name, ...extra })).body.data;

beforeAll(async () => {
  await startTestDb();
  app = createApp({ sessionMiddleware: createSessionMiddleware() });
});
afterAll(stopTestDb);

beforeEach(async () => {
  await clearTestDb();
  await runSeed({ productName: 'P', companyName: 'C', workspaceDomain: 'engenx.in' });
  await seedStatusLists();
  await seedStartingLists();
  const roles = Object.fromEntries((await Role.find()).map((role) => [role.name, role]));
  const makeUser = (email, name, roleName) =>
    User.create({ email, name, roleId: roles[roleName]._id, status: 'active', password: PASSWORD });
  ceo = await makeUser('ceo@engenx.in', 'Kunal CEO', 'CEO');
  manager = await makeUser('manager@engenx.in', 'Meera Manager', 'Sales Manager');
  agent = await makeUser('agent@engenx.in', 'Asha Agent', 'Sales Agent');
  otherAgent = await makeUser('other@engenx.in', 'Omar Agent', 'Sales Agent');
  [asCeo, asManager, asAgent, asOther] = await Promise.all(
    [ceo, manager, agent, otherAgent].map(signedInAs),
  );
  const created = await asAgent.post('/api/accounts/quick-add').send({
    account: { name: 'Bharat Forge', industry: 'Forging', hq: { city: 'Pune' } },
    contacts: [{ name: 'Asha Verma' }],
  });
  accountId = created.body.data.account.id;
  contactId = created.body.data.contacts[0].id;
  await AuditLog.deleteMany({});
});

describe('tags', () => {
  it('everyone reads tags; only someone with the settings permission manages them', async () => {
    const tag = await makeTag('Key account', { color: 'brand' });
    expect(tag).toMatchObject({ name: 'Key account', color: 'brand' });
    expect((await request(app).get('/api/tags')).status).toBe(401);
    for (const client of [asManager, asAgent]) {
      expect((await client.get('/api/tags')).body.data.map((item) => item.name)).toEqual([
        'Key account',
      ]);
      expect((await client.post('/api/tags').send({ name: 'Mine' })).status).toBe(403);
      expect((await client.patch(`/api/tags/${tag.id}`).send({ name: 'X' })).status).toBe(403);
      expect((await client.delete(`/api/tags/${tag.id}`)).status).toBe(403);
    }
  });

  it('refuses the same name in another letter case, and bad input', async () => {
    await makeTag('Hot');
    for (const name of ['hot', ' HOT ', 'Hot']) {
      expect((await asCeo.post('/api/tags').send({ name })).status, name).toBe(409);
    }
    for (const body of [
      { name: '' },
      { name: 'x'.repeat(41) },
      { name: 'A', color: '#ff0000' },
      { name: 'A', appliesTo: [] },
    ]) {
      expect((await asCeo.post('/api/tags').send(body)).status).toBe(400);
    }
    expect(await Tag.countDocuments()).toBe(1);
  });

  it('a tag is put on a company and on a person, shows by name, and filters the list', async () => {
    const key = await makeTag('Key account');
    const expo = await makeTag('Exhibition 2026');
    const tagged = await asAgent
      .patch(`/api/accounts/${accountId}`)
      .send({ tagIds: [key.id, expo.id, key.id] });
    expect(tagged.status).toBe(200);
    expect(tagged.body.data.tags.map((tag) => tag.name)).toEqual([
      'Key account',
      'Exhibition 2026',
    ]);
    const person = await asAgent.patch(`/api/contacts/${contactId}`).send({ tagIds: [expo.id] });
    expect(person.body.data.tags.map((tag) => tag.name)).toEqual(['Exhibition 2026']);

    await asCeo.post('/api/accounts').send({ name: 'Untagged Co' });
    const filtered = await asCeo.get(`/api/accounts?tagId=${key.id}`);
    expect(filtered.body.data.map((account) => account.name)).toEqual(['Bharat Forge']);
    expect(filtered.body.data[0].tags.map((tag) => tag.name)).toContain('Key account');

    // The audit entry names the tags.
    const entry = await AuditLog.findOne({ action: 'account.updated' }).lean();
    expect(entry.newValue).toEqual({ tags: ['Key account', 'Exhibition 2026'] });
    expect(entry.oldValue).toEqual({ tags: [] });
  });

  it('only real tags that are offered for that kind of record can be chosen', async () => {
    const peopleOnly = await makeTag('Decision maker', { appliesTo: ['contact'] });
    const onAccount = await asAgent
      .patch(`/api/accounts/${accountId}`)
      .send({ tagIds: [peopleOnly.id] });
    expect(onAccount.status).toBe(400);
    expect(onAccount.body.error.details[0].field).toBe('tagIds');
    expect(
      (await asAgent.patch(`/api/contacts/${contactId}`).send({ tagIds: [peopleOnly.id] })).status,
    ).toBe(200);
    expect(
      (
        await asAgent
          .patch(`/api/accounts/${accountId}`)
          .send({ tagIds: ['0123456789abcdef01234567'] })
      ).status,
    ).toBe(400);
  });

  it('a rename shows on every record at once', async () => {
    const tag = await makeTag('Hot');
    await asAgent.patch(`/api/accounts/${accountId}`).send({ tagIds: [tag.id] });
    expect(
      (await asCeo.patch(`/api/tags/${tag.id}`).send({ name: 'Hot lead', color: 'danger' })).status,
    ).toBe(200);
    const account = await asAgent.get(`/api/accounts/${accountId}`);
    expect(account.body.data.tags).toEqual([
      {
        id: tag.id,
        name: 'Hot lead',
        color: 'danger',
        appliesTo: ['account', 'contact', 'opportunity'],
      },
    ]);
  });

  it('deleting a tag takes it off every record', async () => {
    const tag = await makeTag('Old campaign');
    const keep = await makeTag('Keep');
    await asAgent.patch(`/api/accounts/${accountId}`).send({ tagIds: [tag.id, keep.id] });
    await asAgent.patch(`/api/contacts/${contactId}`).send({ tagIds: [tag.id] });

    const withUses = await asCeo.get('/api/tags?withUses=true');
    expect(withUses.body.data.find((item) => item.id === tag.id).uses).toBe(2);

    const removed = await asCeo.delete(`/api/tags/${tag.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body.data.removedFrom).toBe(2);
    expect(
      (await asAgent.get(`/api/accounts/${accountId}`)).body.data.tags.map((t) => t.name),
    ).toEqual(['Keep']);
    expect((await Contact.findById(contactId).lean()).tagIds).toEqual([]);
    expect((await Account.findById(accountId).lean()).tagIds.map(String)).toEqual([keep.id]);
  });

  it('merging keeps every link and gives no record the same tag twice', async () => {
    const hot = await makeTag('Hot');
    const veryHot = await makeTag('Very hot');
    const second = (await asCeo.post('/api/accounts').send({ name: 'Second Co' })).body.data;
    // First company has both tags; second has only the one that goes away.
    await asAgent.patch(`/api/accounts/${accountId}`).send({ tagIds: [hot.id, veryHot.id] });
    await asCeo.patch(`/api/accounts/${second.id}`).send({ tagIds: [veryHot.id] });
    await asAgent.patch(`/api/contacts/${contactId}`).send({ tagIds: [veryHot.id] });

    const merged = await asCeo.post(`/api/tags/${veryHot.id}/merge`).send({ intoTagId: hot.id });
    expect(merged.status).toBe(200);
    expect(merged.body.data.moved).toBe(3);

    const tagsOf = async (id) => (await Account.findById(id).lean()).tagIds.map(String);
    expect(await tagsOf(accountId)).toEqual([hot.id]); // once, not twice
    expect(await tagsOf(second.id)).toEqual([hot.id]);
    expect((await Contact.findById(contactId).lean()).tagIds.map(String)).toEqual([hot.id]);
    expect(await Tag.countDocuments()).toBe(1);

    expect((await asCeo.post(`/api/tags/${hot.id}/merge`).send({ intoTagId: hot.id })).status).toBe(
      400,
    );
    expect(
      (
        await asCeo
          .post(`/api/tags/${hot.id}/merge`)
          .send({ intoTagId: '0123456789abcdef01234567' })
      ).status,
    ).toBe(404);
  });
});

describe('solution categories as a managed list', () => {
  const base = '/api/status-lists/solution-categories';

  it('lists the seeded 16, and they can be added, renamed, reordered, switched off and deleted', async () => {
    const list = await asAgent.get(base);
    expect(list.body.data).toHaveLength(16);
    expect(list.body.data[0]).toMatchObject({
      name: 'Digital Twin',
      isActive: true,
      isDefault: false,
    });

    const added = await asCeo.post(base).send({ name: 'Robotics' });
    expect(added.status).toBe(201);
    expect(added.body.data).toMatchObject({ name: 'Robotics', key: null, isDefault: false });
    expect((await asCeo.post(base).send({ name: 'oee' })).status).toBe(409);

    const id = added.body.data.id;
    expect((await asCeo.patch(`${base}/${id}`).send({ name: 'Robotics and cobots' })).status).toBe(
      200,
    );
    expect((await asCeo.patch(`${base}/${id}`).send({ isActive: false })).status).toBe(200);
    // This list has no default entry.
    expect((await asCeo.patch(`${base}/${id}`).send({ isDefault: true })).status).toBe(400);

    const ids = (await asCeo.get(base)).body.data.map((item) => item.id);
    const reordered = await asCeo.put(`${base}/order`).send({ ids: [...ids].reverse() });
    expect(reordered.body.data[0].name).toBe('Robotics and cobots');

    expect((await asCeo.delete(`${base}/${id}`)).status).toBe(200);
    expect((await asCeo.get(base)).body.data).toHaveLength(16);
    expect((await asAgent.post(base).send({ name: 'Nope' })).status).toBe(403);
  });
});

describe('departments and production lines', () => {
  let plantId;
  beforeEach(async () => {
    plantId = (await asAgent.post(`/api/accounts/${accountId}/plants`).send({ name: 'Pune Plant' }))
      .body.data.id;
  });
  const addUnit = (body) => asAgent.post(`/api/plants/${plantId}/units`).send(body);

  it('a line can sit under a department or directly in the plant; a machine can be placed in either', async () => {
    const machining = (await addUnit({ type: 'department', name: 'Machining' })).body.data;
    const line1 = await addUnit({ type: 'line', name: 'Line 1', parentId: machining.id });
    expect(line1.status).toBe(201);
    expect(line1.body.data).toMatchObject({ type: 'line', name: 'Line 1', parentId: machining.id });
    const loose = (await addUnit({ type: 'line', name: 'Packing line' })).body.data;
    expect(loose.parentId).toBeNull();

    const units = await asAgent.get(`/api/plants/${plantId}/units`);
    expect(units.body.data.map((unit) => `${unit.type}:${unit.name}`)).toEqual([
      'department:Machining',
      'line:Line 1',
      'line:Packing line',
    ]);

    const machine = await asAgent
      .post(`/api/plants/${plantId}/machines`)
      .send({ name: 'CNC', unitId: line1.body.data.id });
    expect(machine.body.data.unitId).toBe(line1.body.data.id);
    const moved = await asAgent
      .patch(`/api/machines/${machine.body.data.id}`)
      .send({ unitId: null });
    expect(moved.body.data.unitId).toBeNull();
  });

  it('refuses a wrong parent, a duplicate name, and a unit of another plant', async () => {
    const machining = (await addUnit({ type: 'department', name: 'Machining' })).body.data;
    const line = (await addUnit({ type: 'line', name: 'Line 1' })).body.data;

    // A department has no parent; a line's parent must be a department.
    expect(
      (await addUnit({ type: 'department', name: 'Sub', parentId: machining.id })).status,
    ).toBe(400);
    expect((await addUnit({ type: 'line', name: 'Line 2', parentId: line.id })).status).toBe(400);
    expect((await addUnit({ type: 'department', name: 'machining' })).status).toBe(409);
    // The same name is fine for the other kind.
    expect((await addUnit({ type: 'line', name: 'Machining' })).status).toBe(201);
    expect((await addUnit({ type: 'area', name: 'X' })).status).toBe(400);

    const otherPlant = (
      await asAgent.post(`/api/accounts/${accountId}/plants`).send({ name: 'Second Plant' })
    ).body.data;
    const foreign = (
      await asAgent
        .post(`/api/plants/${otherPlant.id}/units`)
        .send({ type: 'department', name: 'Assembly' })
    ).body.data;
    expect((await addUnit({ type: 'line', name: 'Line 9', parentId: foreign.id })).status).toBe(
      400,
    );
    const badMachine = await asAgent
      .post(`/api/plants/${plantId}/machines`)
      .send({ name: 'Press', unitId: foreign.id });
    expect(badMachine.status).toBe(400);
    expect(badMachine.body.error.details[0].field).toBe('unitId');
  });

  it('renames and moves; deleting a department frees its lines and machines instead of deleting them', async () => {
    const machining = (await addUnit({ type: 'department', name: 'Machining' })).body.data;
    const assembly = (await addUnit({ type: 'department', name: 'Assembly' })).body.data;
    const line = (await addUnit({ type: 'line', name: 'Line 1', parentId: machining.id })).body
      .data;
    const machine = (
      await asAgent
        .post(`/api/plants/${plantId}/machines`)
        .send({ name: 'Lathe', unitId: machining.id })
    ).body.data;

    const moved = await asAgent
      .patch(`/api/plant-units/${line.id}`)
      .send({ name: 'Line A', parentId: assembly.id });
    expect(moved.body.data).toMatchObject({ name: 'Line A', parentId: assembly.id });

    // An agent cannot delete; the CEO can.
    expect((await asAgent.delete(`/api/plant-units/${assembly.id}`)).status).toBe(403);
    expect((await asCeo.delete(`/api/plant-units/${assembly.id}`)).status).toBe(200);
    expect((await asCeo.delete(`/api/plant-units/${machining.id}`)).status).toBe(200);

    const units = (await asAgent.get(`/api/plants/${plantId}/units`)).body.data;
    expect(units).toEqual([expect.objectContaining({ name: 'Line A', parentId: null })]);
    expect((await Machine.findById(machine.id).lean()).unitId).toBeUndefined();
    expect((await asAgent.get(`/api/plants/${plantId}/machines`)).body.data).toHaveLength(1);
  });

  it('is hidden from someone who cannot see the company', async () => {
    const unit = (await addUnit({ type: 'department', name: 'Machining' })).body.data;
    expect((await asOther.get(`/api/plants/${plantId}/units`)).status).toBe(404);
    expect(
      (await asOther.post(`/api/plants/${plantId}/units`).send({ type: 'line', name: 'X' })).status,
    ).toBe(404);
    expect(
      (await asOther.patch(`/api/plant-units/${unit.id}`).send({ name: 'Hacked' })).status,
    ).toBe(404);
  });
});

describe('accounts export', () => {
  beforeEach(async () => {
    await asCeo.post('/api/accounts').send({
      name: 'Alpha, "Steel" Ltd',
      industry: 'Steel',
      phone_number: '020 2612 3456',
      gstin: '27ABCDE1234F1Z5',
      hq: { city: 'Mumbai' },
    });
    await asCeo
      .post('/api/accounts')
      .send({ name: '=HYPERLINK("http://evil.example")', industry: 'Steel' });
  });

  it('writes cells that spreadsheets read correctly and never run as formulas', () => {
    const csv = toCsv(
      [
        { header: 'Name', value: (row) => row.name },
        { header: 'Note', value: (row) => row.note },
      ],
      [
        { name: 'Plain', note: null },
        { name: 'Has, comma', note: 'Has "quotes"' },
        { name: '=SUM(A1)', note: '+91 98765' },
        { name: 'Two\nlines', note: '@mention' },
      ],
    );
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).split('\r\n')).toEqual([
      'Name,Note',
      'Plain,',
      '"Has, comma","Has ""quotes"""',
      "'=SUM(A1),'+91 98765",
      '"Two\nlines",\'@mention',
      '',
    ]);
  });

  it('needs the export permission: a manager and the CEO have it, an agent does not', async () => {
    expect((await request(app).get('/api/accounts/export')).status).toBe(401);
    expect((await asAgent.get('/api/accounts/export')).status).toBe(403);
    expect((await asManager.get('/api/accounts/export')).status).toBe(200);
  });

  it('exports what the filters show, as a file, without tax numbers, and records it', async () => {
    const response = await asCeo.get('/api/accounts/export?industry=Steel&sort=name');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toMatch(
      /attachment; filename="accounts-\d{4}-\d{2}-\d{2}\.csv"/,
    );

    const lines = response.text.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe(
      'Code,Company,Status,Industry,Company type,Company size,Phone,Email,Website,City,State,Country,Region,Owner,Tags,Source,Created',
    );
    expect(lines).toHaveLength(3); // header + the two Steel accounts, not Bharat Forge
    expect(lines[1]).toContain("'=HYPERLINK"); // made harmless
    expect(lines[2]).toContain('"Alpha, ""Steel"" Ltd",Prospect,Steel');
    expect(lines[2]).toContain('+912026123456');
    expect(lines[2]).toContain('Mumbai');
    expect(response.text).not.toContain('27ABCDE1234F1Z5');

    const entry = await AuditLog.findOne({ action: 'account.exported' }).lean();
    expect(String(entry.userId)).toBe(String(ceo._id));
    expect(entry.newValue).toMatchObject({
      accounts: 2,
      filters: { industry: 'Steel', sort: 'name' },
    });
  });

  it('rejects wrong filters, and an empty result is still a valid file', async () => {
    expect((await asCeo.get('/api/accounts/export?statusId=nope')).status).toBe(400);
    expect((await asCeo.get('/api/accounts/export?range=custom&from=2026-10-09')).status).toBe(400);
    const empty = await asCeo.get('/api/accounts/export?industry=Nothing');
    expect(empty.status).toBe(200);
    expect(empty.text.slice(1).trim().split('\r\n')).toHaveLength(1);
  });
});
