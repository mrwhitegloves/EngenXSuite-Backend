import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// File storage is replaced by a Map, so the tests never reach AWS.
const BUCKET_URL = 'https://test-bucket.s3.ap-south-1.amazonaws.com/';
const stored = new Map();
vi.mock('../infra/storage.js', () => ({
  isStorageConfigured: () => true,
  objectUrl: (key) => `${BUCKET_URL}${key}`,
  keyFromUrl: (url) => (url?.startsWith(BUCKET_URL) ? url.slice(BUCKET_URL.length) : null),
  uploadObject: async ({ key, body }) => {
    stored.set(key, Buffer.from(body));
    return `${BUCKET_URL}${key}`;
  },
  readObject: async (key) => stored.get(key) ?? null,
  deleteObject: async (key) => {
    stored.delete(key);
  },
  toReadableUrl: async (url) => (url ? `${url}?X-Amz-Signature=test` : null),
}));

const { createApp } = await import('../app.js');
const { decodeCsv, parseCsv } = await import('../lib/csv.js');
const { createSessionMiddleware } = await import('../middleware/session.js');
const { Account } = await import('../models/account.model.js');
const { AuditLog } = await import('../models/auditLog.model.js');
const { Contact } = await import('../models/contact.model.js');
const { Import } = await import('../models/import.model.js');
const { Role } = await import('../models/role.model.js');
const { User } = await import('../models/user.model.js');
const { runSeed, seedStatusLists } = await import('../seeds/seed.js');
const { createAccount } = await import('../services/accounts.service.js');
const { loadRequestUser } = await import('../services/auth.service.js');
const { suggestMapping, uniqueHeaders } = await import('../services/importRows.service.js');
const { resumeInterruptedImports, runImport, runImportUndo, runWhenFree } =
  await import('../services/imports.service.js');
const { clearTestDb, startTestDb, stopTestDb } = await import('./helpers/testDb.js');

const PASSWORD = 'correct-horse-battery';
let app;
let ceo;
let agent;
let asCeo;
let asManager;
let asAgent;

async function signedInAs(user) {
  const client = request.agent(app);
  const response = await client
    .post('/api/auth/login')
    .send({ email: user.email, password: PASSWORD });
  expect(response.status).toBe(200);
  return client;
}

const csvOf = (...lines) => `${lines.join('\r\n')}\r\n`;
const upload = (client, text, name = 'list.csv') =>
  client.post('/api/imports').attach('file', Buffer.from(text, 'utf8'), name);

/** Ask for the import until its background work is over. */
async function finished(client, id) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const { data } = (await client.get(`/api/imports/${id}`)).body;
    if (['completed', 'failed', 'undone'].includes(data.status)) return data;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('The import did not finish');
}

/** Upload, start with the suggested mapping, and wait for the result. */
async function runFile(client, text, { duplicateMode = 'skip', mapping } = {}) {
  const uploaded = (await upload(client, text)).body.data;
  const started = await client
    .post(`/api/imports/${uploaded.id}/run`)
    .send({ mapping: mapping ?? uploaded.mapping, duplicateMode });
  expect(started.status).toBe(200);
  return finished(client, uploaded.id);
}

const PEOPLE_FILE = csvOf(
  'Company Name,Contact Person,Designation,Mobile No.,E-mail,City,Website',
  'Bharat Forge Ltd,Asha Verma,Plant Head,98765 43210,Asha@BharatForge.com,Pune,bharatforge.com',
  'Bharat Forge Ltd,Ravi Kumar,Maintenance Head,09123456780,,Pune,',
  'Tata Steel,,,,,Jamshedpur,tatasteel.com',
);

beforeAll(async () => {
  await startTestDb();
  app = createApp({ sessionMiddleware: createSessionMiddleware() });
});
afterAll(stopTestDb);

beforeEach(async () => {
  await clearTestDb();
  stored.clear();
  await runSeed({ productName: 'P', companyName: 'C', workspaceDomain: 'engenx.in' });
  await seedStatusLists();
  const roles = Object.fromEntries((await Role.find()).map((role) => [role.name, role]));
  const makeUser = (email, name, roleName) =>
    User.create({ email, name, roleId: roles[roleName]._id, status: 'active', password: PASSWORD });
  ceo = await makeUser('ceo@engenx.in', 'Kunal CEO', 'CEO');
  const manager = await makeUser('manager@engenx.in', 'Meera Manager', 'Sales Manager');
  agent = await makeUser('agent@engenx.in', 'Asha Agent', 'Sales Agent');
  [asCeo, asManager, asAgent] = await Promise.all([ceo, manager, agent].map(signedInAs));
});

describe('reading CSV text', () => {
  it('reads quoted cells, both line ends, and leaves empty rows out', () => {
    const rows = parseCsv('Name,Note\r\n"Alpha, Ltd","Said ""hi""\nand left"\n\n,\nBeta,\n');
    expect(rows).toEqual([
      ['Name', 'Note'],
      ['Alpha, Ltd', 'Said "hi"\nand left'],
      ['Beta', ''],
    ]);
  });

  it('finds the separator Excel used, and reads Excel’s own text encoding', () => {
    expect(parseCsv('Name;City\nAlpha;Pune\n')).toEqual([
      ['Name', 'City'],
      ['Alpha', 'Pune'],
    ]);
    expect(parseCsv('Name\tCity\nAlpha\tPune')).toEqual([
      ['Name', 'City'],
      ['Alpha', 'Pune'],
    ]);
    // "Café" saved by Excel as plain CSV (Windows-1252), and as UTF-8 with its mark.
    expect(decodeCsv(Buffer.from([0x43, 0x61, 0x66, 0xe9]))).toBe('Café');
    expect(decodeCsv(Buffer.from('﻿Café', 'utf8'))).toBe('Café');
  });
});

describe('suggesting which column fills which field', () => {
  it('gives email and phone columns to the person when the file names a person', () => {
    const headers = ['Company Name', 'Contact Person', 'Mobile No.', 'WhatsApp', 'E-mail', 'City'];
    expect(suggestMapping(headers)).toEqual([
      { column: 'Company Name', field: 'name' },
      { column: 'Contact Person', field: 'contact.name' },
      { column: 'Mobile No.', field: 'contact.phone_number' },
      { column: 'WhatsApp', field: 'contact.alt_phone_number' },
      { column: 'E-mail', field: 'contact.email' },
      { column: 'City', field: 'hq.city' },
    ]);
  });

  it('gives them to the company when the file has no person, or the heading says so', () => {
    expect(suggestMapping(['Name', 'Phone', 'Email ID', 'Hotel', 'GST No'])).toEqual([
      { column: 'Name', field: 'name' },
      { column: 'Phone', field: 'phone_number' },
      { column: 'Email ID', field: 'email' },
      { column: 'GST No', field: 'gstin' },
    ]);
    expect(suggestMapping(['Company', 'Name', 'Office Phone', 'Mobile'])).toEqual([
      { column: 'Company', field: 'name' },
      { column: 'Name', field: 'contact.name' },
      { column: 'Office Phone', field: 'phone_number' },
      { column: 'Mobile', field: 'contact.phone_number' },
    ]);
  });

  it('makes headings unique and never empty', () => {
    expect(uniqueHeaders([' Phone ', '', 'phone', 'City'])).toEqual([
      'Phone',
      'Column 2',
      'phone (2)',
      'City',
    ]);
  });
});

describe('who may import', () => {
  it('needs the import permission: the CEO and a manager have it, an agent does not', async () => {
    expect((await request(app).get('/api/imports')).status).toBe(401);
    expect((await asAgent.get('/api/imports')).status).toBe(403);
    expect((await asAgent.get('/api/imports/options')).status).toBe(403);
    expect((await upload(asAgent, PEOPLE_FILE)).status).toBe(403);
    expect((await asManager.get('/api/imports')).status).toBe(200);
    expect((await upload(asManager, PEOPLE_FILE)).status).toBe(201);
    expect(await Import.countDocuments()).toBe(1);
  });

  it('a person with the "own" scope sees only their own imports, and cannot touch others’', async () => {
    await Role.updateOne(
      { name: 'Sales Agent' },
      {
        $push: {
          grants: {
            $each: ['view', 'create'].map((action) => ({
              feature: 'imports',
              action,
              scope: 'own',
            })),
          },
        },
      },
    );
    const theirs = (await upload(asCeo, PEOPLE_FILE)).body.data;
    const mine = (await upload(asAgent, PEOPLE_FILE)).body.data;
    expect((await asAgent.get('/api/imports')).body.data.map((item) => item.id)).toEqual([mine.id]);
    expect((await asCeo.get('/api/imports')).body.data).toHaveLength(2);
    expect((await asAgent.get(`/api/imports/${theirs.id}`)).status).toBe(404);
    const run = await asAgent
      .post(`/api/imports/${theirs.id}/run`)
      .send({ mapping: theirs.mapping, duplicateMode: 'skip' });
    expect(run.status).toBe(404);
    expect((await asAgent.post(`/api/imports/${theirs.id}/undo`)).status).toBe(404);
  });
});

describe('uploading', () => {
  it('stores the file and answers its headings, first rows and a suggested mapping', async () => {
    const response = await upload(asCeo, PEOPLE_FILE, 'Expo leads.CSV');
    expect(response.status).toBe(201);
    const data = response.body.data;
    expect(data).toMatchObject({
      fileName: 'Expo leads.CSV',
      status: 'uploaded',
      rowCount: 3,
      processedRows: 0,
      headers: [
        'Company Name',
        'Contact Person',
        'Designation',
        'Mobile No.',
        'E-mail',
        'City',
        'Website',
      ],
      createdBy: { name: 'Kunal CEO' },
    });
    expect(data.sampleRows[0][0]).toBe('Bharat Forge Ltd');
    expect(data.mapping).toContainEqual({ column: 'Mobile No.', field: 'contact.phone_number' });
    expect([...stored.keys()]).toEqual([`imports/${data.id}/source.csv`]);
    // Nothing is saved from the file yet.
    expect(await Account.countDocuments()).toBe(0);

    const options = (await asCeo.get('/api/imports/options')).body.data;
    expect(options.fields.find((item) => item.field === 'name')).toEqual({
      field: 'name',
      label: 'Company name',
      group: 'Company',
      required: true,
    });
    expect(options.limits).toEqual({ maxBytes: 5 * 1024 * 1024, maxRows: 5000 });
  });

  it('refuses what is not a usable CSV file', async () => {
    const attach = (buffer, name) => asCeo.post('/api/imports').attach('file', buffer, name);
    const tooManyRows = csvOf('Company', ...Array.from({ length: 5001 }, (_, n) => `Co ${n}`));
    // Each request is made when its turn comes.
    const cases = [
      [() => upload(asCeo, PEOPLE_FILE, 'list.xlsx'), /not a CSV file/],
      [() => attach(Buffer.from([80, 75, 3, 4, 0, 0]), 'a.csv'), /not a CSV file/],
      [() => upload(asCeo, 'Company\r\n'), /heading row and at least one row/],
      [() => upload(asCeo, tooManyRows), /limit is 5000/],
      [() => attach(Buffer.alloc(5 * 1024 * 1024 + 1, 'a'), 'big.csv'), /too large/],
      [() => asCeo.post('/api/imports'), /Choose a file/],
    ];
    for (const [send, message] of cases) {
      const response = await send();
      expect(response.status).toBe(400);
      expect(response.body.error.message).toMatch(message);
    }
    expect(await Import.countDocuments()).toBe(0);
    expect(stored.size).toBe(0);
  });
});

describe('checking before anything is saved', () => {
  it('counts good and bad rows, names each problem, and saves nothing', async () => {
    await asCeo.post('/api/accounts').send({ name: 'Tata Steel Limited' });
    const file = csvOf(
      'Company,Person,Phone,Email,Employees,Revenue',
      'Bharat Forge,Asha Verma,98765 43210,asha@bf.com,4500,"2,50,00,000"',
      'Bharat Forge,Ravi Kumar,,,,',
      'Tata Steel,,,,,',
      ',Nobody,,,,',
      'Bad Phone Co,Someone,12345,not-an-email,,',
      'Odd Co,,,,many,lots',
    );
    const uploaded = (await upload(asCeo, file)).body.data;
    const preview = await asCeo
      .post(`/api/imports/${uploaded.id}/preview`)
      .send({ mapping: uploaded.mapping, duplicateMode: 'skip' });
    expect(preview.status).toBe(200);
    expect(preview.body.data.counts).toEqual({
      total: 6,
      valid: 3,
      invalid: 3,
      newCompanies: 1,
      existing: 2, // the second Bharat Forge row, and Tata Steel (already in the CRM)
      people: 2,
    });
    expect(preview.body.data.problems).toEqual([
      { row: 4, message: 'Company name: Enter the company name' },
      {
        row: 5,
        message:
          'Person phone: Enter a phone number with its area code · Person email: Enter a valid email address',
      },
      {
        row: 6,
        message:
          'Company size (people): use a number, or one of 1-50, 51-200, 201-1000, 1001-5000, 5000+ · Yearly revenue (₹): enter a plain number, for example 25000000',
      },
    ]);
    expect(await Account.countDocuments()).toBe(1);
    expect((await Import.findById(uploaded.id).lean()).status).toBe('mapped');
  });

  it('refuses a mapping that cannot work', async () => {
    const uploaded = (await upload(asCeo, PEOPLE_FILE)).body.data;
    const preview = (mapping) =>
      asCeo.post(`/api/imports/${uploaded.id}/preview`).send({ mapping, duplicateMode: 'skip' });
    const cases = [
      [[{ column: 'City', field: 'hq.city' }], /company name/],
      [
        [
          { column: 'Company Name', field: 'name' },
          { column: 'Nope', field: 'hq.city' },
        ],
        /no column "Nope"/,
      ],
      [
        [
          { column: 'Company Name', field: 'name' },
          { column: 'City', field: 'ownerId' },
        ],
        /not a field/,
      ],
      [
        [
          { column: 'Company Name', field: 'name' },
          { column: 'City', field: 'name' },
        ],
        /two columns/,
      ],
      [
        [
          { column: 'Company Name', field: 'name' },
          { column: 'E-mail', field: 'contact.email' },
        ],
        /person’s name/,
      ],
    ];
    for (const [mapping, message] of cases) {
      const response = await preview(mapping);
      expect(response.status).toBe(400);
      expect(response.body.error.message).toMatch(message);
    }
  });
});

describe('running an import', () => {
  it('saves companies and people through the usual rules, and reports each row', async () => {
    const existing = (await asCeo.post('/api/accounts').send({ name: 'Tata Steel Limited' })).body
      .data;
    await AuditLog.deleteMany({});
    const file = csvOf(
      'Company Name,Contact Person,Designation,Mobile No.,E-mail,City,Website',
      'Bharat Forge Ltd,Asha Verma,Plant Head,98765 43210,Asha@BharatForge.com,Pune,bharatforge.com',
      'Bharat Forge Ltd,Ravi Kumar,Maintenance Head,09123456780,,Pune,',
      'Tata Steel,,,,,Jamshedpur,tatasteel.com',
      ',Nobody,,,,,',
      'Bharat Forge,Asha V.,,9876543210,,,',
    );
    const result = await runFile(asCeo, file);

    expect(result).toMatchObject({
      status: 'completed',
      processedRows: 5,
      // Row 1 creates the company; row 2 adds a person to it; Tata Steel is there already and
      // "skip" leaves it alone; row 4 has no company; row 5 is Asha again (same phone).
      counts: { created: 1, updated: 1, skipped: 2, failed: 1 },
      rowErrors: [{ row: 4, message: 'Company name: Enter the company name' }],
      hasErrorFile: true,
    });
    expect(result.errorFileLink).toContain(`imports/${result.id}/errors.csv?X-Amz-Signature`);

    const created = await Account.findOne({ name: 'Bharat Forge Ltd' }).lean();
    expect(created).toMatchObject({
      accountCode: 'EGX-10002',
      source: 'import',
      importRow: 1,
      website: 'https://bharatforge.com',
      hq: { city: 'Pune' },
    });
    expect(String(created.importId)).toBe(result.id);
    expect(String(created.ownerId)).toBe(String(ceo._id));
    expect(created.formFilledBy).toBeUndefined();
    const people = await Contact.find({ accountId: created._id }).sort({ name: 1 }).lean();
    expect(people.map((person) => [person.name, person.phone_number, person.email])).toEqual([
      ['Asha Verma', '+919876543210', 'asha@bharatforge.com'],
      ['Ravi Kumar', '+919123456780', undefined],
    ]);
    expect(people.every((person) => person.source === 'import')).toBe(true);
    // The company that was there before is untouched.
    expect((await Account.findById(existing.id).lean()).website).toBeUndefined();
    expect(await Account.countDocuments()).toBe(2);

    // The error file: the failed row with its reason and its original cells.
    const errorRows = parseCsv(decodeCsv(stored.get(`imports/${result.id}/errors.csv`)));
    expect(errorRows).toEqual([
      [
        'Row',
        'Problem',
        'Company Name',
        'Contact Person',
        'Designation',
        'Mobile No.',
        'E-mail',
        'City',
        'Website',
      ],
      ['5', 'Company name: Enter the company name', '', 'Nobody', '', '', '', '', ''],
    ]);

    const actions = (await AuditLog.find().sort({ _id: 1 }).lean()).map((entry) => entry.action);
    expect(actions).toEqual([
      'import.uploaded',
      'import.started',
      'account.created',
      'contact.created',
      'contact.created',
      'import.completed',
    ]);
    const done = await AuditLog.findOne({ action: 'import.completed' }).lean();
    expect(done.newValue).toMatchObject({ rows: 5, created: 1, updated: 1, skipped: 2, failed: 1 });
  });

  it('cannot be started twice, and a second run of the job changes nothing', async () => {
    const result = await runFile(asCeo, PEOPLE_FILE);
    expect(result.counts).toEqual({ created: 2, updated: 1, skipped: 0, failed: 0 });
    const again = await asCeo
      .post(`/api/imports/${result.id}/run`)
      .send({ mapping: result.mapping, duplicateMode: 'skip' });
    expect(again.status).toBe(409);
    expect(await runImport(result.id)).toEqual({ skipped: true, busy: false });
    expect(await Account.countDocuments()).toBe(2);
    expect(await Contact.countDocuments()).toBe(2);

    // The same file again, as a new import: every company is there already.
    const second = await runFile(asCeo, PEOPLE_FILE);
    expect(second.counts).toEqual({ created: 0, updated: 0, skipped: 3, failed: 0 });
    expect(await Account.countDocuments()).toBe(2);
    expect(await Contact.countDocuments()).toBe(2);
  });

  it('“update” fills in the existing company and person; “create” always adds a new company', async () => {
    await runFile(asCeo, PEOPLE_FILE);
    const newer = csvOf(
      'Company Name,Contact Person,Designation,Mobile No.,Industry',
      'BHARAT FORGE LIMITED,Asha Verma,Director Operations,9876543210,Forging',
    );
    const updated = await runFile(asCeo, newer, { duplicateMode: 'update' });
    expect(updated.counts).toEqual({ created: 0, updated: 1, skipped: 0, failed: 0 });
    const company = await Account.findOne({ nameKey: 'bharatforge' }).lean();
    expect(company).toMatchObject({ name: 'Bharat Forge Ltd', industry: 'Forging' });
    const asha = await Contact.findOne({ name: 'Asha Verma' }).lean();
    expect(asha).toMatchObject({
      designation: 'Director Operations',
      email: 'asha@bharatforge.com',
    });
    // Nothing differs any more: the same file again changes nothing.
    expect((await runFile(asCeo, newer, { duplicateMode: 'update' })).counts.skipped).toBe(1);

    const forced = await runFile(asCeo, csvOf('Company', 'Bharat Forge'), {
      duplicateMode: 'create',
    });
    expect(forced.counts.created).toBe(1);
    expect(await Account.countDocuments({ nameKey: 'bharatforge' })).toBe(2);
  });

  it('does not change a company that belongs to someone else', async () => {
    await Role.updateOne(
      { name: 'Sales Agent' },
      {
        $push: {
          grants: {
            $each: ['view', 'create'].map((action) => ({
              feature: 'imports',
              action,
              scope: 'own',
            })),
          },
        },
      },
    );
    const theirs = (await asCeo.post('/api/accounts').send({ name: 'Tata Steel' })).body.data;
    const file = csvOf(
      'Company,Person,Industry',
      'Tata Steel,Sneaky Person,Changed',
      'New Co,Fine Person,',
    );
    const result = await runFile(await signedInAs(agent), file, { duplicateMode: 'update' });
    expect(result.counts).toEqual({ created: 1, updated: 0, skipped: 0, failed: 1 });
    expect(result.rowErrors).toEqual([
      { row: 1, message: '"Tata Steel" is already in the CRM and belongs to someone else.' },
    ]);
    expect((await Account.findById(theirs.id).lean()).industry).toBeUndefined();
    expect(await Contact.countDocuments({ accountId: theirs.id })).toBe(0);
  });

  it('goes on at the next row after it was cut off, without saving a row twice', async () => {
    const uploaded = (await upload(asCeo, PEOPLE_FILE)).body.data;
    // The worker died after saving row 1's company, before noting that the row was done.
    const actor = await loadRequestUser(ceo._id);
    await createAccount(
      actor,
      { name: 'Bharat Forge Ltd', confirmDuplicate: true },
      { importId: uploaded.id, importRow: 1, quiet: true },
    );
    const cutOff = { status: 'running', mapping: uploaded.mapping, processedRows: 0 };
    await Import.updateOne({ _id: uploaded.id }, { $set: { ...cutOff, heartbeatAt: new Date() } });

    // Its worker was heard from a moment ago: nobody else takes it.
    expect(await runImport(uploaded.id)).toEqual({ skipped: true, busy: true });
    // Once it has been silent for long enough, the next run takes over.
    await Import.updateOne(
      { _id: uploaded.id },
      { $set: { heartbeatAt: new Date(Date.now() - 5 * 60_000) } },
    );
    expect(await runWhenFree(runImport, uploaded.id, 1)).toMatchObject({ rows: 3, created: 2 });

    const result = (await asCeo.get(`/api/imports/${uploaded.id}`)).body.data;
    expect(result).toMatchObject({ status: 'completed', processedRows: 3 });
    expect(result.counts).toEqual({ created: 2, updated: 1, skipped: 0, failed: 0 });
    expect(await Account.countDocuments({ nameKey: 'bharatforge' })).toBe(1);
  });

  it('at server start, a waiting import is picked up', async () => {
    const uploaded = (await upload(asCeo, PEOPLE_FILE)).body.data;
    await Import.updateOne(
      { _id: uploaded.id },
      { $set: { status: 'queued', mapping: uploaded.mapping } },
    );
    expect(await resumeInterruptedImports()).toBe(1);
    expect((await finished(asCeo, uploaded.id)).counts.created).toBe(2);
  });

  it('stops with a clear reason when the file is gone', async () => {
    const uploaded = (await upload(asCeo, PEOPLE_FILE)).body.data;
    stored.clear();
    await asCeo
      .post(`/api/imports/${uploaded.id}/run`)
      .send({ mapping: uploaded.mapping, duplicateMode: 'skip' });
    const result = await finished(asCeo, uploaded.id);
    expect(result).toMatchObject({
      status: 'failed',
      failureReason: 'The uploaded file is no longer in storage.',
    });
  });
});

describe('undo', () => {
  it('removes exactly what the import created, and nothing else', async () => {
    const before = (
      await asCeo.post('/api/accounts/quick-add').send({
        account: { name: 'Tata Steel' },
        contacts: [{ name: 'Old Contact' }],
      })
    ).body.data;
    const file = csvOf(
      'Company,Person',
      'Bharat Forge,Asha Verma',
      'Tata Steel,New Person',
      'Kirloskar,',
    );
    const result = await runFile(asCeo, file);
    expect(result.counts).toEqual({ created: 2, updated: 1, skipped: 0, failed: 0 });
    // Someone adds a company by hand in the meantime: it is not part of the batch.
    await asCeo.post('/api/accounts').send({ name: 'Added By Hand' });

    // An import that has not run cannot be undone.
    const open = (await upload(asCeo, file)).body.data;
    expect((await asCeo.post(`/api/imports/${open.id}/undo`)).status).toBe(409);

    const undo = await asCeo.post(`/api/imports/${result.id}/undo`);
    expect(undo.status).toBe(200);
    const undone = await finished(asCeo, result.id);
    expect(undone).toMatchObject({
      status: 'undone',
      undo: { accountsRemoved: 2, contactsRemoved: 1, kept: 0 },
    });

    const names = async (model, filter) =>
      (
        await model
          .find({ deletedAt: null, ...filter })
          .sort({ name: 1 })
          .lean()
      ).map((item) => item.name);
    expect(await names(Account)).toEqual(['Added By Hand', 'Tata Steel']);
    expect(await names(Contact, { accountId: before.account.id })).toEqual(['Old Contact']);
    expect(await Contact.countDocuments({ deletedAt: null })).toBe(1);

    expect((await asCeo.post(`/api/imports/${result.id}/undo`)).status).toBe(409);
    expect(await runImportUndo(result.id)).toEqual({ skipped: true, busy: false });
    const actions = (await AuditLog.find({ entityType: 'imports' }).lean()).map(
      (entry) => entry.action,
    );
    expect(actions).toContain('import.undo_started');
    expect(actions).toContain('import.undone');
  });
});

describe('saved mappings', () => {
  it('are saved by name, replaced under the same name, offered again, and deleted', async () => {
    const uploaded = (await upload(asCeo, PEOPLE_FILE)).body.data;
    await asCeo.post(`/api/imports/${uploaded.id}/run`).send({
      mapping: uploaded.mapping,
      duplicateMode: 'skip',
      saveTemplateAs: 'Expo list',
    });
    await finished(asCeo, uploaded.id);

    const shorter = [{ column: 'Company Name', field: 'name' }];
    const saved = await asCeo
      .post('/api/imports/templates')
      .send({ name: ' expo LIST ', mapping: shorter });
    expect(saved.status).toBe(201);
    const templates = (await asCeo.get('/api/imports/options')).body.data.templates;
    expect(templates).toEqual([
      { id: saved.body.data.id, name: 'expo LIST', targetType: 'accounts', mapping: shorter },
    ]);

    expect(
      (await asAgent.post('/api/imports/templates').send({ name: 'X', mapping: shorter })).status,
    ).toBe(403);
    expect(
      (await asCeo.post('/api/imports/templates').send({ name: '', mapping: shorter })).status,
    ).toBe(400);
    expect((await asCeo.delete(`/api/imports/templates/${templates[0].id}`)).status).toBe(200);
    expect((await asCeo.delete(`/api/imports/templates/${templates[0].id}`)).status).toBe(404);
  });
});
