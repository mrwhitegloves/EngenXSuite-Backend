import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

// The Website screen's analytics, read from the WEBSITE's database. Here that database is a
// second in-memory MongoDB, filled the way the website's tracker and contact form fill it.
const { MongoMemoryServer } = await import('mongodb-memory-server');
const siteServer = await MongoMemoryServer.create();
process.env.WEBSITE_MONGODB_URI = siteServer.getUri();
process.env.WEBSITE_DB_NAME = 'engenx_site_test';

const mongoose = (await import('mongoose')).default;
const { createApp } = await import('../app.js');
const { createSessionMiddleware } = await import('../middleware/session.js');
const { Role } = await import('../models/role.model.js');
const { User } = await import('../models/user.model.js');
const { runSeed } = await import('../seeds/seed.js');
const { clearTestDb, startTestDb, stopTestDb } = await import('./helpers/testDb.js');

const PASSWORD = 'correct-horse-battery';
let app;
let site;
let asCeo;
let asManager;
let asAgent;

// A moment in India time: "2026-10-03 23:30" is still the 3rd in India (18:00 UTC).
const ist = (text) => new Date(`${text}:00+05:30`);
const view = (text, extra = {}) => ({
  timestamp: ist(text),
  path: '/',
  referrer: 'Direct',
  device: 'Desktop',
  browser: 'Chrome',
  ipHash: 'visitor-a',
  ipAddress: '49.36.10.1',
  location: { country: 'India', countryCode: 'IN', regionName: 'Jharkhand', city: 'Ranchi' },
  duration: 0,
  ...extra,
});
const custom = (from, to) => `range=custom&from=${from}&to=${to}`;

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
  site = mongoose.createConnection(siteServer.getUri(), { dbName: 'engenx_site_test' });
  await site.asPromise();
});
afterAll(async () => {
  await site.close();
  await stopTestDb();
  await siteServer.stop();
});

beforeEach(async () => {
  await clearTestDb();
  await site.db.collection('pageviews').deleteMany({});
  await site.db.collection('leads').deleteMany({});
  await runSeed({ productName: 'P', companyName: 'C', workspaceDomain: 'engenx.in' });
  const roles = Object.fromEntries((await Role.find()).map((role) => [role.name, role]));
  const makeUser = (email, name, roleName) =>
    User.create({ email, name, roleId: roles[roleName]._id, status: 'active', password: PASSWORD });
  const [ceo, manager, agent] = await Promise.all([
    makeUser('ceo@engenx.in', 'Kunal CEO', 'CEO'),
    makeUser('manager@engenx.in', 'Mina Manager', 'Sales Manager'),
    makeUser('agent@engenx.in', 'Asha Agent', 'Sales Agent'),
  ]);
  [asCeo, asManager, asAgent] = await Promise.all([ceo, manager, agent].map(signedInAs));

  await site.db.collection('pageviews').insertMany([
    // Visitor A (Ranchi): three pages on the 2nd and 3rd.
    view('2026-10-02 10:00', { path: '/', duration: 30 }),
    view('2026-10-02 10:01', {
      path: '/platform',
      duration: 90,
      referrer: 'https://www.google.com/',
    }),
    view('2026-10-03 23:30', { path: '/platform', duration: 60 }),
    // Visitor B (Dubai, phone): one page on the 3rd.
    view('2026-10-03 09:00', {
      ipHash: 'visitor-b',
      ipAddress: '94.200.1.1',
      device: 'Mobile',
      browser: 'Safari',
      path: '/blog',
      duration: 0,
      referrer: 'https://www.linkedin.com/',
      location: {
        country: 'United Arab Emirates',
        countryCode: 'AE',
        regionName: 'Dubai',
        city: 'Dubai',
      },
    }),
    // A local developer visit (not a country) on the 5th.
    view('2026-10-05 12:00', {
      ipHash: 'visitor-local',
      ipAddress: '127.0.0.1',
      path: '/about',
      location: { country: 'Local Network', countryCode: 'LCL', regionName: 'Dev', city: 'Local' },
    }),
    // Outside the October dates below.
    view('2026-09-20 12:00', { ipHash: 'visitor-old', path: '/old' }),
  ]);
  await site.db.collection('leads').insertMany([
    {
      name: 'Rajesh Patil',
      email: 'rajesh@shakti.example',
      company: 'Shakti Castings',
      phone: '+919876543210',
      message: 'Pilot for 4 furnaces',
      timestamp: ist('2026-10-03 11:00'),
    },
    {
      name: 'Meera Iyer',
      email: 'meera@tata.example',
      company: 'Tata Bearings',
      phone: '+919812345678',
      message: 'Vibration analytics',
      timestamp: ist('2026-10-04 15:00'),
    },
    {
      name: 'Old Lead',
      email: '',
      company: '',
      phone: '+910000000000',
      message: '',
      timestamp: ist('2026-09-01 10:00'),
    },
  ]);
});

describe('who may see the Website screen', () => {
  it('the CEO and a Sales Manager may; a Sales Agent may not', async () => {
    expect((await asCeo.get('/api/website/status')).body.data).toEqual({ isConfigured: true });
    expect(
      (await asManager.get(`/api/website/analytics/overview?${custom('2026-10-01', '2026-10-07')}`))
        .status,
    ).toBe(200);
    expect((await asAgent.get('/api/website/analytics/overview')).status).toBe(403);
    expect((await asAgent.get('/api/website/analytics/leads')).status).toBe(403);
    expect((await request(app).get('/api/website/analytics/sessions')).status).toBe(401);
  });
});

describe('overview, pages and sources', () => {
  it('counts only the chosen dates, in India days', async () => {
    const response = await asCeo.get(
      `/api/website/analytics/overview?${custom('2026-10-01', '2026-10-07')}`,
    );
    expect(response.status).toBe(200);
    const data = response.body.data;
    expect(data.summary).toEqual({
      pageviews: 5,
      visitors: 3,
      pagesPerVisitor: 1.7,
      avgStaySeconds: 36, // (30 + 90 + 60 + 0 + 0) / 5
      countries: 2, // India and the UAE; the local developer visit is no country
      leads: 2,
    });
    expect(data.mostEngagedPath).toEqual({ path: '/platform', avgStaySeconds: 75 });
    expect(data.topPages[0]).toEqual({
      path: '/platform',
      views: 2,
      share: 40,
      avgStaySeconds: 75,
    });
    expect(data.topPages.map((page) => page.path).sort()).toEqual([
      '/',
      '/about',
      '/blog',
      '/platform',
    ]);
    expect(data.devices).toEqual([
      { device: 'Desktop', views: 4, share: 80 },
      { device: 'Mobile', views: 1, share: 20 },
    ]);
    expect(data.referrers[0]).toEqual({ name: 'Direct', views: 3, share: 60 });
    // One point per India day; 23:30 on the 3rd counts on the 3rd.
    expect(data.traffic.unit).toBe('day');
    expect(data.traffic.points).toHaveLength(7);
    expect(data.traffic.points.slice(0, 5)).toEqual([
      { date: '2026-10-01', views: 0, visitors: 0 },
      { date: '2026-10-02', views: 2, visitors: 1 },
      { date: '2026-10-03', views: 2, visitors: 2 },
      { date: '2026-10-04', views: 0, visitors: 0 },
      { date: '2026-10-05', views: 1, visitors: 1 },
    ]);
  });

  it('without dates counts everything; a long range is charted per month; a bad range is refused', async () => {
    const all = (await asCeo.get('/api/website/analytics/overview')).body.data;
    expect(all.summary).toMatchObject({ pageviews: 6, visitors: 4, leads: 3 });
    expect(all.range).toBeNull();
    const year = (
      await asCeo.get(`/api/website/analytics/overview?${custom('2026-01-01', '2026-12-31')}`)
    ).body.data;
    expect(year.traffic.unit).toBe('month');
    expect(year.traffic.points).toHaveLength(12);
    expect(year.traffic.points.find((point) => point.date === '2026-10')).toEqual({
      date: '2026-10',
      views: 5,
      visitors: 3,
    });
    expect(
      (
        await asCeo.get(
          '/api/website/analytics/overview?range=custom&from=2026-10-09&to=2026-10-01',
        )
      ).status,
    ).toBe(400);
  });
});

describe('visitor sessions', () => {
  it('one row per visitor, newest first, with pages, stay time and search', async () => {
    const response = await asCeo.get(
      `/api/website/analytics/sessions?${custom('2026-10-01', '2026-10-07')}`,
    );
    expect(response.status).toBe(200);
    expect(response.body.meta).toEqual({ page: 1, pageSize: 25, total: 3 });
    const [local, visitorA, visitorB] = response.body.data;
    expect(local.ipAddress).toBe('127.0.0.1');
    expect(visitorA).toMatchObject({
      ipAddress: '49.36.10.1',
      location: { city: 'Ranchi', country: 'India', countryCode: 'IN' },
      device: 'Desktop',
      pagesCount: 3,
      paths: ['/', '/platform'],
      totalDurationSeconds: 180,
    });
    expect(new Date(visitorA.lastActive).toISOString()).toBe(ist('2026-10-03 23:30').toISOString());
    expect(visitorB).toMatchObject({ device: 'Mobile', browser: 'Safari', pagesCount: 1 });

    const dubai = (await asCeo.get('/api/website/analytics/sessions?search=dubai')).body;
    expect(dubai.data.map((row) => row.ipAddress)).toEqual(['94.200.1.1']);
    const paged = (await asCeo.get('/api/website/analytics/sessions?pageSize=2&page=2')).body;
    expect(paged.meta).toEqual({ page: 2, pageSize: 2, total: 4 });
    expect(paged.data).toHaveLength(2);
  });
});

describe('contact leads', () => {
  it('newest first, inside the dates, with search', async () => {
    const response = await asManager.get(
      `/api/website/analytics/leads?${custom('2026-10-01', '2026-10-07')}`,
    );
    expect(response.status).toBe(200);
    expect(response.body.data.map((lead) => lead.name)).toEqual(['Meera Iyer', 'Rajesh Patil']);
    expect(response.body.data[1]).toMatchObject({
      email: 'rajesh@shakti.example',
      company: 'Shakti Castings',
      phone: '+919876543210',
      message: 'Pilot for 4 furnaces',
    });
    const found = (await asManager.get('/api/website/analytics/leads?search=furnace')).body;
    expect(found.data.map((lead) => lead.name)).toEqual(['Rajesh Patil']);
    const all = (await asManager.get('/api/website/analytics/leads')).body;
    expect(all.meta.total).toBe(3);
    expect(all.data[2]).toMatchObject({ name: 'Old Lead', email: null, company: null });
  });
});
