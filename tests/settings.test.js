import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { createSessionMiddleware } from '../middleware/session.js';
import { AuditLog } from '../models/auditLog.model.js';
import { Role } from '../models/role.model.js';
import { Settings } from '../models/settings.model.js';
import { User } from '../models/user.model.js';
import { runSeed } from '../seeds/seed.js';
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

const publicBranding = async () => (await request(app).get('/api/public/branding')).body.data;

beforeAll(async () => {
  await startTestDb();
  app = createApp({ sessionMiddleware: createSessionMiddleware() });
});
afterAll(stopTestDb);

beforeEach(async () => {
  await clearTestDb();
  await runSeed({
    productName: 'First Name',
    companyName: 'First Co',
    workspaceDomain: 'engenx.in',
  });
  const roles = Object.fromEntries((await Role.find()).map((role) => [role.name, role]));
  const makeUser = (email, roleName) =>
    User.create({
      email,
      name: email,
      roleId: roles[roleName]._id,
      status: 'active',
      password: PASSWORD,
    });
  ceo = await makeUser('ceo@engenx.in', 'CEO');
  manager = await makeUser('manager@engenx.in', 'Sales Manager');
  agent = await makeUser('agent@engenx.in', 'Sales Agent');
  await AuditLog.deleteMany({});
});

describe('branding settings', () => {
  it('needs a session, and the settings permission', async () => {
    const body = { productName: 'Hacked' };
    expect((await request(app).patch('/api/settings/branding').send(body)).status).toBe(401);
    for (const user of [manager, agent]) {
      const client = await signedInAs(user);
      expect((await client.patch('/api/settings/branding').send(body)).status).toBe(403);
    }
    expect(await publicBranding()).toEqual({ productName: 'First Name', companyName: 'First Co' });
  });

  it('the product name changes everywhere at once, without a deploy', async () => {
    const client = await signedInAs(ceo);
    const response = await client
      .patch('/api/settings/branding')
      .send({ productName: '  Sales Desk  ' });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ productName: 'Sales Desk', companyName: 'First Co' });
    // The public answer (sign-in page, page title) shows it on the very next request.
    expect(await publicBranding()).toEqual({ productName: 'Sales Desk', companyName: 'First Co' });
    expect((await request(app).get('/api/public/config')).body.data.branding.productName).toBe(
      'Sales Desk',
    );
  });

  it('changes both names, and keeps the rest of the settings record', async () => {
    const before = await Settings.findOne({ key: 'app' }).lean();
    const client = await signedInAs(ceo);
    await client
      .patch('/api/settings/branding')
      .send({ productName: 'Sales Desk', companyName: 'New Co Pvt Ltd' });
    const after = await Settings.findOne({ key: 'app' }).lean();
    expect(after.branding).toMatchObject({
      productName: 'Sales Desk',
      companyName: 'New Co Pvt Ltd',
    });
    expect(String(after._id)).toBe(String(before._id));
    expect(await Settings.countDocuments()).toBe(1);
  });

  it('writes one audit entry with the old and new values, and none when nothing changed', async () => {
    const client = await signedInAs(ceo);
    await client.patch('/api/settings/branding').send({ productName: 'Sales Desk' });
    // The same values again: nothing to record.
    await client
      .patch('/api/settings/branding')
      .send({ productName: 'Sales Desk', companyName: 'First Co' });

    const entries = await AuditLog.find({ entityType: 'settings' }).lean();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'settings.branding_updated',
      oldValue: { productName: 'First Name' },
      newValue: { productName: 'Sales Desk' },
    });
    expect(String(entries[0].userId)).toBe(String(ceo._id));

    // The audit log screen shows a readable record name for it.
    const log = await client.get('/api/audit-logs?entityType=settings');
    expect(log.body.data[0].entityName).toBe('Product settings');
  });

  it('rejects empty, too long and multi-line names, and an empty request', async () => {
    const client = await signedInAs(ceo);
    for (const body of [
      {},
      { productName: '' },
      { productName: '   ' },
      { productName: 'x'.repeat(61) },
      { companyName: 'x'.repeat(121) },
      { productName: 'Two\nLines' },
      { productName: 42 },
    ]) {
      const response = await client.patch('/api/settings/branding').send(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(await publicBranding()).toEqual({ productName: 'First Name', companyName: 'First Co' });
  });

  it('works on a database that was never seeded', async () => {
    await Settings.deleteMany({});
    const client = await signedInAs(ceo);
    const response = await client.patch('/api/settings/branding').send({ productName: 'Fresh' });
    expect(response.status).toBe(200);
    expect((await publicBranding()).productName).toBe('Fresh');
    expect(await Settings.countDocuments()).toBe(1);
  });
});
