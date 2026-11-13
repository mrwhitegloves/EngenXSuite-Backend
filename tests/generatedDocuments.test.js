import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// The Document generator (/api/generator): saved proposals, letter heads and invoices, each kind
// behind its own permission feature with the owner scope.

// Chromium is not started in tests: the renderer is replaced by a fake that answers a tiny PDF.
const rendered = [];
let browserInstalled = true;
vi.mock('../infra/pdfRenderer.js', () => ({
  isPdfRendererAvailable: () => browserInstalled,
  renderPdf: async (html) => {
    rendered.push(html);
    return Buffer.from('%PDF-1.7 fake');
  },
}));

const { createApp } = await import('../app.js');
const { createSessionMiddleware } = await import('../middleware/session.js');
const { AuditLog } = await import('../models/auditLog.model.js');
const { GeneratedDocument } = await import('../models/generatedDocument.model.js');
const { Role } = await import('../models/role.model.js');
const { User } = await import('../models/user.model.js');
const { runSeed } = await import('../seeds/seed.js');
const { clearTestDb, startTestDb, stopTestDb } = await import('./helpers/testDb.js');

const PASSWORD = 'correct-horse-battery';

let app;
let ceo;
let manager;
let agent;
let otherAgent;

async function signedInAs(user) {
  const client = request.agent(app);
  await client.post('/api/auth/login').send({ email: user.email, password: PASSWORD });
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
  const roles = Object.fromEntries((await Role.find()).map((role) => [role.name, role]));
  const make = (email, role, extra = {}) =>
    User.create({
      email,
      name: email,
      roleId: roles[role]._id,
      status: 'active',
      password: PASSWORD,
      ...extra,
    });
  ceo = await make('ceo@engenx.in', 'CEO');
  manager = await make('manager@engenx.in', 'Sales Manager');
  agent = await make('agent@engenx.in', 'Sales Agent', { managerId: manager._id });
  otherAgent = await make('other@engenx.in', 'Sales Agent');
});

const PROPOSAL = {
  templateKey: 'engenx-assessment',
  title: 'Industrial Digital Maturity Assessment',
  refNo: 'ENGENX-SPB-DMA-2026-001',
  clientName: 'Sripathi Paper and Boards Pvt. Ltd.',
  data: { client: { name: 'Sripathi Paper and Boards Pvt. Ltd.' }, fee: { amount: 75000 } },
};

describe('document generator: proposals', () => {
  it('saves, lists, opens, edits and deletes a proposal; every step is audited', async () => {
    const client = await signedInAs(agent);
    const created = await client.post('/api/generator/proposals').send(PROPOSAL);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      kind: 'proposal',
      title: PROPOSAL.title,
      data: PROPOSAL.data,
    });
    const id = created.body.data.id;

    const list = await client.get('/api/generator/proposals?search=sripathi');
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).not.toHaveProperty('data');
    expect(list.body.meta.total).toBe(1);

    const opened = await client.get(`/api/generator/proposals/${id}`);
    expect(opened.body.data.data.fee.amount).toBe(75000);

    const edited = await client.patch(`/api/generator/proposals/${id}`).send({
      data: { ...PROPOSAL.data, fee: { amount: 90000 } },
      updatedAt: opened.body.data.updatedAt,
    });
    expect(edited.status).toBe(200);
    expect(edited.body.data.data.fee.amount).toBe(90000);

    // A save from the older copy is refused instead of overwriting the newer one.
    const stale = await client
      .patch(`/api/generator/proposals/${id}`)
      .send({ title: 'Old copy', updatedAt: opened.body.data.updatedAt });
    expect(stale.status).toBe(409);

    // Sales Agents may not delete proposals (seeded grants: view, create, edit).
    expect((await client.delete(`/api/generator/proposals/${id}`)).status).toBe(403);
    const boss = await signedInAs(ceo);
    expect((await boss.delete(`/api/generator/proposals/${id}`)).status).toBe(200);
    expect(await GeneratedDocument.countDocuments()).toBe(0);

    const actions = (
      await AuditLog.find({ entityType: 'generated_documents' }).sort({ _id: 1 }).lean()
    ).map((entry) => entry.action);
    expect(actions).toEqual(['proposal.generated', 'proposal.updated', 'proposal.deleted']);
  });

  it('an agent sees only their own proposals; a manager their team; the CEO all', async () => {
    const mine = (await (await signedInAs(agent)).post('/api/generator/proposals').send(PROPOSAL))
      .body.data;
    await (await signedInAs(otherAgent)).post('/api/generator/proposals').send(PROPOSAL);

    const other = await signedInAs(otherAgent);
    expect((await other.get(`/api/generator/proposals/${mine.id}`)).status).toBe(404);
    expect(
      (await other.patch(`/api/generator/proposals/${mine.id}`).send({ title: 'x' })).status,
    ).toBe(404);
    expect((await other.get('/api/generator/proposals')).body.meta.total).toBe(1);

    // Seeded: managers have proposals with scope "all"; the CEO too.
    expect(
      (await (await signedInAs(manager)).get('/api/generator/proposals')).body.meta.total,
    ).toBe(2);
    expect((await (await signedInAs(ceo)).get('/api/generator/proposals')).body.meta.total).toBe(2);
  });

  it('refuses bad input, other kinds without permission, and strangers', async () => {
    const client = await signedInAs(agent);
    expect(
      (await client.post('/api/generator/proposals').send({ ...PROPOSAL, title: '' })).status,
    ).toBe(400);
    expect(
      (
        await client
          .post('/api/generator/proposals')
          .send({ ...PROPOSAL, data: { big: 'x'.repeat(400000) } })
      ).status,
    ).toBe(400);
    expect(
      (await client.post('/api/generator/proposals').send({ ...PROPOSAL, extra: 1 })).status,
    ).toBe(400);
    // Invoices: only the CEO by default.
    expect((await client.get('/api/generator/invoices')).status).toBe(403);
    expect((await (await signedInAs(ceo)).get('/api/generator/invoices')).status).toBe(200);
    // Not signed in.
    expect((await request(app).get('/api/generator/proposals')).status).toBe(401);
    expect((await request(app).get('/api/generator/assets/seal')).status).toBe(401);
  });

  it('gives the seal picture only to people who may use the generator', async () => {
    const response = await (await signedInAs(agent)).get('/api/generator/assets/seal');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('image/png');
    expect(response.headers['cache-control']).toContain('private');
  });
});

describe('document generator: one-click PDF', () => {
  const PAGE = `<!doctype html><html><body>${'<p>Proposal</p>'.repeat(20)}</body></html>`;

  it('turns the page into a PDF file named after the document', async () => {
    rendered.length = 0;
    browserInstalled = true;
    const response = await (
      await signedInAs(agent)
    )
      .post('/api/generator/pdf')
      .send({ html: PAGE, fileName: 'ENGENX-001 - Assessment: Tata Steel Ltd.' });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/pdf');
    expect(response.headers['content-disposition']).toContain(
      'filename="ENGENX-001 - Assessment Tata Steel Ltd..pdf"',
    );
    expect(rendered).toEqual([PAGE]);
  });

  it('accepts a page larger than the usual 1 MB limit, refuses empty or huge ones', async () => {
    const client = await signedInAs(agent);
    const big = `<html><body>${'x'.repeat(2 * 1024 * 1024)}</body></html>`;
    expect(
      (await client.post('/api/generator/pdf').send({ html: big, fileName: 'Big' })).status,
    ).toBe(200);
    expect((await client.post('/api/generator/pdf').send({ html: '', fileName: 'x' })).status).toBe(
      400,
    );
    const huge = 'x'.repeat(9 * 1024 * 1024);
    expect([400, 413]).toContain(
      (await client.post('/api/generator/pdf').send({ html: huge, fileName: 'x' })).status,
    );
    // Other requests keep the 1 MB limit.
    const tooBig = { ...PROPOSAL, data: { text: 'x'.repeat(1.2 * 1024 * 1024) } };
    expect((await client.post('/api/generator/proposals').send(tooBig)).status).toBe(413);
  });

  it('answers 503 without a browser, and refuses people who are not signed in', async () => {
    browserInstalled = false;
    const response = await (
      await signedInAs(agent)
    )
      .post('/api/generator/pdf')
      .send({ html: PAGE, fileName: 'x' });
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('PDF_UNAVAILABLE');
    browserInstalled = true;
    expect(
      (await request(app).post('/api/generator/pdf').send({ html: PAGE, fileName: 'x' })).status,
    ).toBe(401);
  });
});
