import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { createSessionMiddleware } from '../middleware/session.js';
import { AuditLog } from '../models/auditLog.model.js';
import { Contact } from '../models/contact.model.js';
import { Machine } from '../models/machine.model.js';
import { Plant } from '../models/plant.model.js';
import { Role } from '../models/role.model.js';
import { User } from '../models/user.model.js';
import { runSeed, seedStatusLists } from '../seeds/seed.js';
import { clearTestDb, startTestDb, stopTestDb } from './helpers/testDb.js';

const PASSWORD = 'correct-horse-battery';
let app;
let ceo;
let agent;
let otherAgent;
// Signed-in clients and the records every test starts with.
let asAgent;
let asOther;
let asCeo;
let accountId;
let asha;
let ravi;

async function signedInAs(user) {
  const client = request.agent(app);
  const response = await client
    .post('/api/auth/login')
    .send({ email: user.email, password: PASSWORD });
  expect(response.status).toBe(200);
  return client;
}

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
  asAgent = await signedInAs(agent);
  asOther = await signedInAs(otherAgent);
  asCeo = await signedInAs(ceo);

  // The agent's company with two people.
  const created = await asAgent.post('/api/accounts/quick-add').send({
    account: { name: 'Bharat Forge' },
    contacts: [
      { name: 'Asha Verma', designation: 'Plant Head', phone_number: '9876543210' },
      { name: 'Ravi Kumar', email: 'ravi@bharatforge.com' },
    ],
  });
  accountId = created.body.data.account.id;
  [asha, ravi] = created.body.data.contacts;
  await AuditLog.deleteMany({});
});

describe('editing and deleting a contact', () => {
  it('changes fields, clears with null, and records old and new values', async () => {
    const response = await asAgent.patch(`/api/contacts/${asha.id}`).send({
      designation: 'Plant Director',
      phone_number: '09123 456780',
      department: 'Operations',
      decisionPower: 5,
      stakeholderRole: 'plant_head',
    });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      designation: 'Plant Director',
      phone_number: '+919123456780',
      department: 'Operations',
      decisionPower: 5,
      stakeholderRole: 'plant_head',
    });
    expect(
      (await asAgent.patch(`/api/contacts/${asha.id}`).send({ department: null })).status,
    ).toBe(200);
    expect((await Contact.findById(asha.id).lean()).department).toBeUndefined();

    const first = await AuditLog.findOne({ action: 'contact.updated' }).sort({ at: 1 }).lean();
    expect(first.oldValue).toMatchObject({
      designation: 'Plant Head',
      phone_number: '+919876543210',
    });
    expect(first.newValue).toMatchObject({ designation: 'Plant Director', decisionPower: 5 });
  });

  it('saving unchanged values writes nothing', async () => {
    const response = await asAgent
      .patch(`/api/contacts/${asha.id}`)
      .send({ name: 'Asha Verma', phone_number: '98765 43210' });
    expect(response.status).toBe(200);
    expect(await AuditLog.countDocuments()).toBe(0);
    expect((await asAgent.patch(`/api/contacts/${asha.id}`).send({})).status).toBe(400);
  });

  it('records consent with the time it was given or withdrawn', async () => {
    const optedIn = await asAgent
      .patch(`/api/contacts/${asha.id}`)
      .send({ consent: { whatsappOptIn: true, doNotCall: true } });
    expect(optedIn.body.data.consent).toMatchObject({ whatsappOptIn: true, doNotCall: true });
    let stored = await Contact.findById(asha.id).lean();
    expect(stored.consent.whatsappOptInAt).toBeInstanceOf(Date);
    expect(stored.consent.whatsappOptOutAt).toBeUndefined();

    await asAgent.patch(`/api/contacts/${asha.id}`).send({ consent: { whatsappOptIn: false } });
    stored = await Contact.findById(asha.id).lean();
    expect(stored.consent.whatsappOptIn).toBe(false);
    expect(stored.consent.whatsappOptOutAt).toBeInstanceOf(Date);
    expect(stored.consent.doNotCall).toBe(true); // untouched
    const entries = await AuditLog.find({ action: 'contact.updated' }).sort({ at: 1 }).lean();
    expect(entries[0].newValue).toEqual({ whatsappOptIn: true, doNotCall: true });
    expect(entries[1].newValue).toEqual({ whatsappOptIn: false });
  });

  it('refuses a phone or email that another person of the company has; its own is fine', async () => {
    const clash = await asAgent
      .patch(`/api/contacts/${ravi.id}`)
      .send({ phone_number: '9876543210' });
    expect(clash.status).toBe(409);
    expect(clash.body.error.message).toContain('Asha Verma');
    const own = await asAgent
      .patch(`/api/contacts/${ravi.id}`)
      .send({ email: 'RAVI@bharatforge.com', designation: 'Maintenance Head' });
    expect(own.status).toBe(200);
  });

  it('is hidden from someone who cannot see the company: 404, also for a made-up id', async () => {
    expect((await asOther.patch(`/api/contacts/${asha.id}`).send({ name: 'Hacked' })).status).toBe(
      404,
    );
    // An agent may not delete at all: the same 403 for any id, so it reveals nothing.
    expect((await asOther.delete(`/api/contacts/${asha.id}`)).status).toBe(403);
    expect(
      (await asAgent.patch('/api/contacts/0123456789abcdef01234567').send({ name: 'X' })).status,
    ).toBe(404);
    expect((await request(app).patch(`/api/contacts/${asha.id}`).send({ name: 'X' })).status).toBe(
      401,
    );
    expect((await Contact.findById(asha.id).lean()).name).toBe('Asha Verma');
  });

  it('an agent may edit but not delete; the CEO deletes, and the person leaves the list', async () => {
    expect((await asAgent.delete(`/api/contacts/${ravi.id}`)).status).toBe(403);
    expect((await asCeo.delete(`/api/contacts/${ravi.id}`)).status).toBe(200);
    const list = await asAgent.get(`/api/accounts/${accountId}/contacts`);
    expect(list.body.data.map((contact) => contact.name)).toEqual(['Asha Verma']);
    expect((await asCeo.delete(`/api/contacts/${ravi.id}`)).status).toBe(404);
    expect((await Contact.findById(ravi.id).lean()).deletedAt).toBeInstanceOf(Date);
    // A deleted person's email is free to use again.
    expect(
      (
        await asAgent
          .post(`/api/accounts/${accountId}/contacts`)
          .send({ name: 'Ravi K', email: 'ravi@bharatforge.com' })
      ).status,
    ).toBe(201);
  });
});

describe('plants', () => {
  const plantBody = (overrides = {}) => ({
    name: 'Pune Plant',
    location: { city: 'Pune', state: 'Maharashtra' },
    plantType: 'Forging',
    digitalMaturity: 'basic',
    plantHeadId: asha.id,
    itOtContactIds: [ravi.id],
    ...overrides,
  });

  it('a plant belongs to its company and names its people by contact, not by typed name', async () => {
    const created = await asAgent.post(`/api/accounts/${accountId}/plants`).send(plantBody());
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      accountId,
      name: 'Pune Plant',
      location: { city: 'Pune', state: 'Maharashtra' },
      digitalMaturity: 'basic',
      plantHead: { id: asha.id, name: 'Asha Verma', designation: 'Plant Head' },
      maintenanceHead: null,
      itOtContacts: [{ id: ravi.id, name: 'Ravi Kumar' }],
      machineRows: 0,
      machineCount: 0,
    });

    // Renaming the contact shows on the plant at once: the plant stores only the id.
    await asAgent.patch(`/api/contacts/${asha.id}`).send({ name: 'Asha V. Verma' });
    const list = await asAgent.get(`/api/accounts/${accountId}/plants`);
    expect(list.body.data[0].plantHead.name).toBe('Asha V. Verma');
  });

  it('refuses people of another company, a duplicate plant name, and bad input', async () => {
    const elsewhere = await asCeo.post('/api/accounts/quick-add').send({
      account: { name: 'Other Co' },
      contacts: [{ name: 'Outsider' }],
    });
    const outsiderId = elsewhere.body.data.contacts[0].id;
    expect(
      (
        await asAgent
          .post(`/api/accounts/${accountId}/plants`)
          .send(plantBody({ plantHeadId: outsiderId }))
      ).status,
    ).toBe(400);

    expect((await asAgent.post(`/api/accounts/${accountId}/plants`).send(plantBody())).status).toBe(
      201,
    );
    const again = await asAgent
      .post(`/api/accounts/${accountId}/plants`)
      .send({ name: ' pune plant ' });
    expect(again.status).toBe(409);
    // The same name at another company is fine.
    expect(
      (
        await asCeo
          .post(`/api/accounts/${elsewhere.body.data.account.id}/plants`)
          .send({ name: 'Pune Plant' })
      ).status,
    ).toBe(201);

    const bad = await asAgent
      .post(`/api/accounts/${accountId}/plants`)
      .send({ name: '', digitalMaturity: 'expert', plantHeadId: 'nope' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.map((detail) => detail.field).sort()).toEqual([
      'digitalMaturity',
      'name',
      'plantHeadId',
    ]);
  });

  it('edits merge the address, clear with null, and are audited', async () => {
    const plant = (await asAgent.post(`/api/accounts/${accountId}/plants`).send(plantBody())).body
      .data;
    const response = await asAgent.patch(`/api/plants/${plant.id}`).send({
      location: { city: 'Chakan' },
      plantHeadId: null,
      maintenanceHeadId: ravi.id,
      plcScada: 'Siemens S7 / WinCC',
    });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      location: { city: 'Chakan', state: 'Maharashtra' },
      plantHead: null,
      maintenanceHead: { name: 'Ravi Kumar' },
      plcScada: 'Siemens S7 / WinCC',
    });
    const entry = await AuditLog.findOne({ action: 'plant.updated' }).lean();
    expect(entry.newValue).toMatchObject({ plcScada: 'Siemens S7 / WinCC', plantHeadId: null });
    // A rename to its own name in another letter case is not a clash with itself.
    expect(
      (await asAgent.patch(`/api/plants/${plant.id}`).send({ name: 'PUNE PLANT' })).status,
    ).toBe(200);
  });

  it('is hidden from someone who cannot see the company', async () => {
    const plant = (await asAgent.post(`/api/accounts/${accountId}/plants`).send(plantBody())).body
      .data;
    expect((await asOther.get(`/api/accounts/${accountId}/plants`)).status).toBe(404);
    expect(
      (await asOther.post(`/api/accounts/${accountId}/plants`).send({ name: 'Spy Plant' })).status,
    ).toBe(404);
    expect((await asOther.patch(`/api/plants/${plant.id}`).send({ name: 'Hacked' })).status).toBe(
      404,
    );
    expect((await asOther.get(`/api/plants/${plant.id}/machines`)).status).toBe(404);
    expect((await request(app).get(`/api/accounts/${accountId}/plants`)).status).toBe(401);
  });

  it('deleting a contact clears every plant that named that person', async () => {
    const plant = (
      await asAgent
        .post(`/api/accounts/${accountId}/plants`)
        .send(
          plantBody({ plantHeadId: ravi.id, digitalHeadId: ravi.id, maintenanceHeadId: asha.id }),
        )
    ).body.data;
    expect((await asCeo.delete(`/api/contacts/${ravi.id}`)).status).toBe(200);

    const after = (await asAgent.get(`/api/accounts/${accountId}/plants`)).body.data[0];
    expect(after).toMatchObject({
      plantHead: null,
      digitalHead: null,
      itOtContacts: [],
      maintenanceHead: { name: 'Asha Verma' }, // someone else: untouched
    });
    const stored = await Plant.findById(plant.id).lean();
    expect(stored.plantHeadId).toBeUndefined();
    expect(stored.itOtContactIds).toEqual([]);
  });
});

describe('machines', () => {
  let plantId;
  beforeEach(async () => {
    plantId = (await asAgent.post(`/api/accounts/${accountId}/plants`).send({ name: 'Pune Plant' }))
      .body.data.id;
  });

  it('one row can stand for many identical machines; the plant shows rows and machines', async () => {
    const cnc = await asAgent.post(`/api/plants/${plantId}/machines`).send({
      name: 'CNC turning centre',
      quantity: 32,
      machineType: 'CNC',
      manufacturer: 'Mazak',
      controller: 'Fanuc',
      yearInstalled: new Date().getFullYear() - 6,
      criticality: 'high',
      dataAvailability: 'partial',
      existingSensors: ['Spindle load', 'Vibration'],
    });
    expect(cnc.status).toBe(201);
    expect(cnc.body.data).toMatchObject({
      quantity: 32,
      ageYears: 6, // worked out from the year, not stored
      criticality: 'high',
      existingSensors: ['Spindle load', 'Vibration'],
    });
    const press = await asAgent
      .post(`/api/plants/${plantId}/machines`)
      .send({ name: 'Forging press' });
    expect(press.body.data.quantity).toBe(1);

    const machines = await asAgent.get(`/api/plants/${plantId}/machines`);
    expect(machines.body.data.map((machine) => machine.name)).toEqual([
      'CNC turning centre',
      'Forging press',
    ]);
    const plant = (await asAgent.get(`/api/accounts/${accountId}/plants`)).body.data[0];
    expect(plant).toMatchObject({ machineRows: 2, machineCount: 33 });
    expect((await Machine.findById(cnc.body.data.id).lean()).ageYears).toBeUndefined();
  });

  it('edits, rejects bad values, and is hidden outside the company', async () => {
    const machine = (await asAgent.post(`/api/plants/${plantId}/machines`).send({ name: 'Press' }))
      .body.data;
    const edited = await asAgent
      .patch(`/api/machines/${machine.id}`)
      .send({ quantity: 4, plc: 'Siemens S7-1500', condition: null });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ quantity: 4, plc: 'Siemens S7-1500' });

    for (const body of [
      { quantity: 0 },
      { quantity: 1.5 },
      { yearInstalled: 1800 },
      { yearInstalled: new Date().getFullYear() + 5 },
      { criticality: 'extreme' },
      {},
    ]) {
      expect(
        (await asAgent.patch(`/api/machines/${machine.id}`).send(body)).status,
        JSON.stringify(body),
      ).toBe(400);
    }
    expect((await asAgent.post(`/api/plants/${plantId}/machines`).send({ name: '' })).status).toBe(
      400,
    );

    expect((await asOther.patch(`/api/machines/${machine.id}`).send({ quantity: 9 })).status).toBe(
      404,
    );
    // An agent may not delete at all: the same 403 for any id, so it reveals nothing.
    expect((await asOther.delete(`/api/machines/${machine.id}`)).status).toBe(403);
    expect(
      (await asOther.post(`/api/plants/${plantId}/machines`).send({ name: 'Spy' })).status,
    ).toBe(404);
  });

  it('an agent cannot delete; the CEO deletes a machine, a plant with its machines, a company with everything', async () => {
    const machine = (await asAgent.post(`/api/plants/${plantId}/machines`).send({ name: 'Press' }))
      .body.data;
    await asAgent.post(`/api/plants/${plantId}/machines`).send({ name: 'Furnace' });
    expect((await asAgent.delete(`/api/machines/${machine.id}`)).status).toBe(403);
    expect((await asAgent.delete(`/api/plants/${plantId}`)).status).toBe(403);

    expect((await asCeo.delete(`/api/machines/${machine.id}`)).status).toBe(200);
    expect(
      (await asAgent.get(`/api/plants/${plantId}/machines`)).body.data.map((m) => m.name),
    ).toEqual(['Furnace']);

    // Deleting the plant hides its remaining machine too.
    expect((await asCeo.delete(`/api/plants/${plantId}`)).status).toBe(200);
    expect((await asAgent.get(`/api/accounts/${accountId}/plants`)).body.data).toEqual([]);
    expect((await asAgent.get(`/api/plants/${plantId}/machines`)).status).toBe(404);
    expect(await Machine.countDocuments({ deletedAt: null })).toBe(0);
    // The name is free again for a new plant.
    const second = await asAgent
      .post(`/api/accounts/${accountId}/plants`)
      .send({ name: 'Pune Plant' });
    expect(second.status).toBe(201);
    await asAgent.post(`/api/plants/${second.body.data.id}/machines`).send({ name: 'Lathe' });

    // Deleting the company hides its plants and machines with it.
    expect((await asCeo.delete(`/api/accounts/${accountId}`)).status).toBe(200);
    expect(await Plant.countDocuments({ deletedAt: null })).toBe(0);
    expect(await Machine.countDocuments({ deletedAt: null })).toBe(0);
    expect(await Plant.countDocuments()).toBe(2); // kept in the database
  });

  it('the audit log names plants and machines', async () => {
    await asAgent.post(`/api/plants/${plantId}/machines`).send({ name: 'Press' });
    const log = await asCeo.get('/api/audit-logs?entityType=machines');
    expect(log.body.data[0]).toMatchObject({ action: 'machine.created', entityName: 'Press' });
    const plants = await asCeo.get('/api/audit-logs?entityType=plants');
    expect(plants.body.data[0].entityName).toBe('Pune Plant');
  });
});
