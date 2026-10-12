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
const { createSessionMiddleware } = await import('../middleware/session.js');
const { Account } = await import('../models/account.model.js');
const { Activity } = await import('../models/activity.model.js');
const { Contact } = await import('../models/contact.model.js');
const { Opportunity } = await import('../models/opportunity.model.js');
const { PipelineStage } = await import('../models/pipelineStage.model.js');
const { Role } = await import('../models/role.model.js');
const { LeadStatus } = await import('../models/statusLists.model.js');
const { User } = await import('../models/user.model.js');
const { runSeed, seedStartingLists, seedStatusLists } = await import('../seeds/seed.js');
const { suggestMapping, tidyAnswer } = await import('../services/importRows.service.js');
const { clearTestDb, startTestDbWithTransactions, stopTestDb } =
  await import('./helpers/testDb.js');

const PASSWORD = 'correct-horse-battery';
let app;
let ceo;
let asCeo;

// A sheet as exported from a lead tool: enquiries from Meta lead forms and a bought list
// ("apollo_companies_leads") in the same columns. Made-up people.
const HEADERS = [
  'leadgen_id',
  'page_id',
  'form_name',
  'campaign_name',
  'created_time',
  'what_is_your_role_in_the_organization?',
  'what_is_your_biggest_production_challenge_today?',
  'how_soon_are_you_planning_to_implement_a_traceability_solution?',
  'which_manufacturing_industry_does_your_company_belong_to?',
  'what_is_the_approximate_budget_for_solving_this_problem?',
  'full_name',
  'work_email',
  'company_name',
  'job_title',
  'phone_number',
  'status',
  'comment[0].text',
  'comment[1].text',
  'phone_normalized',
  'ad_name',
  'adset_name',
  'Title',
  'Departments',
  'Industry',
  'Person Linkedin Url',
  'Website',
  'Address',
  'City',
  'State',
];
const row = (values) => HEADERS.map((heading) => values[heading] ?? '');
const quote = (cell) => (/[",\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell);
const ROWS = [
  row({
    leadgen_id: 'l:1001',
    form_name: 'Traceability Lead Form',
    campaign_name: 'Traceability Delhi',
    created_time: '2026-08-02T09:15:00.000Z',
    'what_is_your_role_in_the_organization?': 'plant_head',
    'what_is_your_biggest_production_challenge_today?': 'batch_tracking|manual_records',
    'how_soon_are_you_planning_to_implement_a_traceability_solution?': 'within_1_month',
    'which_manufacturing_industry_does_your_company_belong_to?': 'steel_&_metals',
    'what_is_the_approximate_budget_for_solving_this_problem?': '₹1–2_lakh',
    full_name: 'Asha Verma',
    work_email: 'asha@bharatforge.example',
    company_name: 'Bharat Forge',
    phone_number: 'p:+919876543210',
    status: 'Connected',
    'comment[0].text': 'Called. Wants a demo next week.',
    'comment[1].text': 'Demo booked for Friday',
    phone_normalized: '919876543210',
  }),
  row({
    leadgen_id: '1002',
    form_name: 'Lead Form (v1)',
    campaign_name: 'Predictive Maintenance',
    created_time: '2026-08-20T11:00:00.000Z',
    full_name: 'Ravi Kumar',
    company_name: 'Thermax',
    job_title: 'Maintenance Head',
    phone_number: "'+919123456780",
    status: 'Lost',
    'comment[0].text': 'Went with a local vendor',
    ad_name: 'PM Leads ad',
    adset_name: 'PM ad set',
  }),
  row({
    leadgen_id: '1003',
    form_name: 'Lead Form (v1)',
    campaign_name: 'Predictive Maintenance',
    created_time: '2026-09-01T07:30:00.000Z',
    full_name: 'Meena Joshi',
    work_email: 'meena@deccan.example',
    company_name: 'Deccan Castings',
    status: 'Not interested',
  }),
  // The bought list: a company and a person, no enquiry.
  row({
    leadgen_id: '2001',
    form_name: 'apollo_companies_leads',
    created_time: '2026-09-10T00:00:00.000Z',
    full_name: 'Sunil Rao',
    work_email: 'sunil@kirloskar.example',
    company_name: 'Kirloskar Works',
    status: 'New Lead',
    Title: 'Plant Manager',
    Departments: 'Operations',
    Industry: 'machinery',
    'Person Linkedin Url': 'https://www.linkedin.com/in/sunil-rao',
    Website: 'https://kirloskar.example',
    Address: 'Pune, Maharashtra, India',
    City: 'Pune',
    State: 'Maharashtra',
  }),
  // A status that is not in Settings: the row is refused, nothing of it is saved.
  row({
    leadgen_id: '1004',
    form_name: 'Lead Form (v1)',
    campaign_name: 'Predictive Maintenance',
    created_time: '2026-09-02T07:30:00.000Z',
    full_name: 'Nobody Known',
    company_name: 'Unknown Status Ltd',
    work_email: 'nobody@unknown.example',
    status: 'Warm maybe',
  }),
];
const FILE = `${[HEADERS, ...ROWS].map((cells) => cells.map(quote).join(',')).join('\r\n')}\r\n`;
const LEAD_OPTIONS = {
  source: 'meta_ads',
  noLeadColumn: 'form_name',
  noLeadValues: ['apollo_companies_leads'],
};

async function finished(id) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const { data } = (await asCeo.get(`/api/imports/${id}`)).body;
    if (['completed', 'failed', 'undone'].includes(data.status)) return data;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('The import did not finish');
}
const upload = () =>
  asCeo.post('/api/imports').attach('file', Buffer.from(FILE, 'utf8'), 'leads.csv');
async function runFile() {
  const uploaded = (await upload()).body.data;
  const started = await asCeo
    .post(`/api/imports/${uploaded.id}/run`)
    .send({ mapping: uploaded.mapping, duplicateMode: 'skip', leadOptions: LEAD_OPTIONS });
  expect(started.status).toBe(200);
  return finished(uploaded.id);
}

beforeAll(async () => {
  await startTestDbWithTransactions(); // creating a lead uses a transaction
  app = createApp({ sessionMiddleware: createSessionMiddleware() });
});
afterAll(stopTestDb);
beforeEach(async () => {
  await clearTestDb();
  stored.clear();
  await runSeed({ productName: 'P', companyName: 'C', workspaceDomain: 'engenx.in' });
  await seedStatusLists();
  await seedStartingLists();
  const role = await Role.findOne({ name: 'CEO' });
  ceo = await User.create({
    email: 'ceo@engenx.in',
    name: 'Kunal CEO',
    roleId: role._id,
    status: 'active',
    password: PASSWORD,
  });
  asCeo = request.agent(app);
  await asCeo.post('/api/auth/login').send({ email: ceo.email, password: PASSWORD });
});

describe('a file with leads', () => {
  it('the first guess puts every column of such a sheet where it belongs', () => {
    const guess = Object.fromEntries(
      suggestMapping(HEADERS).map(({ column, field }) => [column, field]),
    );
    expect(guess).toEqual({
      leadgen_id: 'lead.externalId',
      form_name: 'lead.form',
      campaign_name: 'lead.campaign',
      created_time: 'lead.createdAt',
      'what_is_your_role_in_the_organization?': 'contact.designation',
      'what_is_your_biggest_production_challenge_today?': 'lead.problemStatement',
      'how_soon_are_you_planning_to_implement_a_traceability_solution?': 'lead.decisionTimeline',
      'which_manufacturing_industry_does_your_company_belong_to?': 'industry',
      'what_is_the_approximate_budget_for_solving_this_problem?': 'lead.answer',
      full_name: 'contact.name',
      work_email: 'contact.email',
      company_name: 'name',
      job_title: 'contact.designation',
      phone_number: 'contact.phone_number',
      status: 'lead.status',
      'comment[0].text': 'lead.note',
      'comment[1].text': 'lead.note',
      ad_name: 'lead.ad',
      adset_name: 'lead.adSet',
      Title: 'contact.designation',
      Departments: 'contact.department',
      Industry: 'industry',
      'Person Linkedin Url': 'contact.linkedinUrl',
      Website: 'website',
      Address: 'hq.addressLine',
      City: 'hq.city',
      State: 'hq.state',
    });
    // Left out on purpose: the page id (no field) and the second copy of the phone number.
    expect(guess.page_id).toBeUndefined();
    expect(guess.phone_normalized).toBeUndefined();
    expect(tidyAnswer('steel_&_metals')).toBe('Steel & metals');
    expect(tidyAnswer('batch_tracking|manual_records')).toBe('Batch tracking, manual records');
    expect(tidyAnswer('Written by a person')).toBe('Written by a person');
  });

  it('the check counts the leads and names a status that Settings does not have', async () => {
    const uploaded = (await upload()).body.data;
    const checked = await asCeo
      .post(`/api/imports/${uploaded.id}/preview`)
      .send({ mapping: uploaded.mapping, duplicateMode: 'skip', leadOptions: LEAD_OPTIONS });
    expect(checked.status).toBe(200);
    expect(checked.body.data.counts).toEqual({
      total: 5,
      valid: 4,
      invalid: 1,
      newCompanies: 4,
      existing: 0,
      people: 4,
      leads: 3,
    });
    expect(checked.body.data.problems).toEqual([
      { row: 5, message: 'Lead status "Warm maybe" is not in Settings → Statuses' },
    ]);
    expect(await Account.countDocuments()).toBe(0);
  });

  it('makes company, person and lead from an enquiry row; company and person only from the list', async () => {
    const result = await runFile();
    expect(result.counts).toEqual({ created: 4, updated: 0, skipped: 0, failed: 1, leads: 3 });
    expect(await Account.countDocuments()).toBe(4); // the refused row saved nothing
    expect(await Contact.countDocuments()).toBe(4);
    expect(await Opportunity.countDocuments()).toBe(3);

    // The enquiry: cleaned phone, coded answers as words, the lead with its source and day.
    const account = await Account.findOne({ name: 'Bharat Forge' }).lean();
    expect(account.industry).toBe('Steel & metals');
    const person = await Contact.findOne({ accountId: account._id }).lean();
    expect(person).toMatchObject({
      name: 'Asha Verma',
      designation: 'Plant head',
      phone_number: '+919876543210',
      email: 'asha@bharatforge.example',
    });
    expect(person.alt_phone_number ?? null).toBeNull();
    const lead = await Opportunity.findOne({ accountId: account._id }).lean();
    const connected = await LeadStatus.findOne({ name: 'Connected' }).lean();
    expect(lead).toMatchObject({
      name: 'Traceability Delhi enquiry',
      status: 'open',
      source: 'meta_ads',
      sourceDetail: {
        campaign: 'Traceability Delhi',
        form: 'Traceability Lead Form',
        externalId: '1001',
      },
      problemStatement: 'Batch tracking, manual records',
      decisionTimeline: 'Within 1 month',
    });
    expect(String(lead.leadStatusId)).toBe(String(connected._id));
    expect(String(lead.ownerId)).toBe(String(ceo._id)); // the person who imports
    expect(String(lead.primaryContactId)).toBe(String(person._id));
    expect(lead.createdAt.toISOString()).toBe('2026-08-02T09:15:00.000Z');
    expect(String(lead.importId)).toBe(result.id);
    const notes = await Activity.find({ opportunityId: lead._id, type: 'NOTE' })
      .sort({ _id: 1 })
      .lean();
    expect(notes.map((note) => note.content)).toEqual([
      'Answers from the lead form:\n- What is the approximate budget for solving this problem? ₹1–2 lakh',
      'Called. Wants a demo next week.',
      'Demo booked for Friday',
    ]);

    // "Lost" and "Not interested" are closed in the lost stage, the status kept.
    const lostStage = await PipelineStage.findOne({ type: 'lost' }).lean();
    const lost = await Opportunity.findOne({ 'sourceDetail.externalId': '1002' }).lean();
    expect(lost).toMatchObject({ status: 'lost', closeReason: 'Went with a local vendor' });
    expect(String(lost.stageId)).toBe(String(lostStage._id));
    expect(lost.sourceDetail).toMatchObject({ ad: 'PM Leads ad', adSet: 'PM ad set' });
    const notInterested = await Opportunity.findOne({ 'sourceDetail.externalId': '1003' }).lean();
    expect(notInterested).toMatchObject({
      status: 'lost',
      closeReason: 'Marked "Not interested" before the import.',
    });
    expect((await Contact.findOne({ name: 'Ravi Kumar' }).lean()).phone_number).toBe(
      '+919123456780',
    );

    // The bought list: a company with its address and a person with their profile, no lead.
    const listed = await Account.findOne({ name: 'Kirloskar Works' }).lean();
    expect(listed).toMatchObject({
      industry: 'machinery',
      website: 'https://kirloskar.example',
      hq: { city: 'Pune', state: 'Maharashtra' },
    });
    expect(await Contact.findOne({ accountId: listed._id }).lean()).toMatchObject({
      name: 'Sunil Rao',
      designation: 'Plant Manager',
      department: 'Operations',
      linkedinUrl: 'https://www.linkedin.com/in/sunil-rao',
    });
    expect(await Opportunity.countDocuments({ accountId: listed._id })).toBe(0);
  });

  it('the same file again makes nothing twice, and the undo takes the leads back first', async () => {
    const first = await runFile();
    const again = await runFile();
    expect(again.counts).toEqual({ created: 0, updated: 0, skipped: 4, failed: 1 });
    expect(await Opportunity.countDocuments()).toBe(3);
    expect(await Account.countDocuments()).toBe(4);

    const undone = await asCeo.post(`/api/imports/${first.id}/undo`);
    expect(undone.status).toBe(200);
    const after = await finished(first.id);
    expect(after.undo).toEqual({
      accountsRemoved: 4,
      contactsRemoved: 0,
      leadsRemoved: 3,
      kept: 0,
    });
    expect(await Opportunity.countDocuments({ deletedAt: null })).toBe(0);
    expect(await Account.countDocuments({ deletedAt: null })).toBe(0);
  });
});
