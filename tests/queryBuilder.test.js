import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { buildFilter, buildSort, containsPattern, runListQuery } from '../lib/queryBuilder.js';
import { createApp } from '../app.js';
import { createSessionMiddleware } from '../middleware/session.js';
import { Role } from '../models/role.model.js';
import { SavedView } from '../models/savedView.model.js';
import { User } from '../models/user.model.js';
import { runSeed } from '../seeds/seed.js';
import { clearTestDb, startTestDb, stopTestDb } from './helpers/testDb.js';

describe('buildFilter', () => {
  it('is empty when nothing is asked for', () => {
    expect(buildFilter()).toEqual({});
    expect(buildFilter({ equals: { status: '', ownerId: undefined, tags: [] } })).toEqual({});
    expect(buildFilter({ search: { text: '   ', fields: ['name'] } })).toEqual({});
  });

  it('combines scope, exact filters, any-of filters, search and dates with AND', () => {
    const filter = buildFilter({
      scope: { ownerId: 'u1' },
      equals: { status: 'active', stage: ['new', 'won'] },
      search: { text: 'steel', fields: ['name', 'city'] },
      dates: {
        field: 'createdAt',
        query: { range: 'custom', from: '2026-10-01', to: '2026-10-01' },
      },
      extra: [{ deletedAt: null }, {}],
    });
    expect(filter.$and).toHaveLength(6);
    expect(filter.$and[0]).toEqual({ ownerId: 'u1' }); // the permission scope always comes first
    expect(filter.$and[1]).toEqual({ status: 'active' });
    expect(filter.$and[2]).toEqual({ stage: { $in: ['new', 'won'] } });
    expect(filter.$and[3].$or.map((part) => Object.keys(part)[0])).toEqual(['name', 'city']);
    expect(filter.$and[4].createdAt.$gte).toBeInstanceOf(Date);
    expect(filter.$and[5]).toEqual({ deletedAt: null });
  });

  it('a single condition is returned as it is', () => {
    expect(buildFilter({ equals: { status: 'active' } })).toEqual({ status: 'active' });
  });

  it('search text is matched literally, never run as a pattern', () => {
    const pattern = containsPattern('a.b*(c)');
    expect(pattern.test('xx A.B*(C) yy')).toBe(true);
    expect(pattern.test('aXb(c)')).toBe(false);
    expect(containsPattern('.*').test('anything')).toBe(false);
  });

  it('passes on the error of a wrong date range', () => {
    expect(() =>
      buildFilter({ dates: { field: 'at', query: { range: 'custom', from: '2026-10-09' } } }),
    ).toThrow(/start date and an end date/);
  });
});

describe('buildSort', () => {
  const allowed = { name: 'name', created: 'createdAt' };

  it('sorts ascending, or descending with a leading minus, and adds _id for a fixed order', () => {
    expect(buildSort('name', allowed, 'name')).toEqual({ name: 1, _id: 1 });
    expect(buildSort('-created', allowed, 'name')).toEqual({ createdAt: -1, _id: 1 });
  });

  it('falls back to the default for a missing or unknown field', () => {
    expect(buildSort(undefined, allowed, '-created')).toEqual({ createdAt: -1, _id: 1 });
    expect(buildSort('password', allowed, 'name')).toEqual({ name: 1, _id: 1 });
    expect(buildSort('$where', allowed, 'name')).toEqual({ name: 1, _id: 1 });
  });

  it('refuses a default that is not allowed (a programming mistake)', () => {
    expect(() => buildSort(undefined, allowed, 'secret')).toThrow(/not in the allowed list/);
  });
});

describe('lists through the API', () => {
  const PASSWORD = 'correct-horse-battery';
  let app;
  let ceo;
  let agent;

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
    ceo = await makeUser('ceo@engenx.in', 'Kunal', 'CEO');
    agent = await makeUser('agent@engenx.in', 'Asha', 'Sales Agent');
    await makeUser('b@engenx.in', 'Bela', 'Sales Agent', { status: 'deactivated' });
    await makeUser('z@engenx.in', 'Zoya', 'Sales Agent');
  });

  it('runListQuery returns one page and the total', async () => {
    const result = await runListQuery(User, {
      filter: {},
      sort: { name: 1, _id: 1 },
      page: 2,
      pageSize: 3,
      select: 'name',
    });
    expect(result.pagination).toEqual({ page: 2, pageSize: 3, total: 4 });
    expect(result.rows.map((row) => row.name)).toEqual(['Zoya']);
    expect(Object.keys(result.rows[0]).sort()).toEqual(['_id', 'name']);
  });

  it('the Users list sorts on the server, both ways, across pages', async () => {
    const client = await signedInAs(ceo);
    const names = async (query) =>
      (await client.get(`/api/users?${query}`)).body.data.map((user) => user.name);

    expect(await names('')).toEqual(['Asha', 'Bela', 'Kunal', 'Zoya']); // default: by name
    expect(await names('sort=-name')).toEqual(['Zoya', 'Kunal', 'Bela', 'Asha']);
    expect(await names('sort=-name&pageSize=2&page=2')).toEqual(['Bela', 'Asha']);
    // Equal values keep one fixed order (by id, the order they were created in).
    expect(await names('sort=status')).toEqual(['Kunal', 'Asha', 'Zoya', 'Bela']);
    // Sort, filter and search together.
    expect(await names('sort=-name&status=active&search=a')).toEqual(['Zoya', 'Kunal', 'Asha']);
  });

  it('refuses to sort by a field that is not offered', async () => {
    const client = await signedInAs(ceo);
    for (const sort of ['password', '-password', 'email', '$natural']) {
      expect((await client.get(`/api/users?sort=${sort}`)).status, sort).toBe(400);
    }
  });

  describe('saved views', () => {
    const view = (overrides = {}) => ({
      screen: 'users',
      name: 'Active only',
      query: { status: 'active', sort: '-name' },
      ...overrides,
    });

    it('needs a session', async () => {
      expect((await request(app).get('/api/saved-views?screen=users')).status).toBe(401);
      expect((await request(app).post('/api/saved-views').send(view())).status).toBe(401);
    });

    it('a user saves, lists, replaces and deletes their own views', async () => {
      const client = await signedInAs(agent);
      const created = await client.post('/api/saved-views').send(view());
      expect(created.status).toBe(201);
      expect(created.body.data).toMatchObject({ name: 'Active only', query: { status: 'active' } });

      await client.post('/api/saved-views').send(view({ name: 'A first' }));
      // Other screens keep their own list.
      await client.post('/api/saved-views').send(view({ screen: 'audit-log', name: 'Other' }));
      const list = await client.get('/api/saved-views?screen=users');
      expect(list.body.data.map((item) => item.name)).toEqual(['A first', 'Active only']);

      // Saving the same name again replaces it instead of making a second one.
      await client.post('/api/saved-views').send(view({ query: { status: 'deactivated' } }));
      const after = await client.get('/api/saved-views?screen=users');
      expect(after.body.data).toHaveLength(2);
      expect(after.body.data[1].query).toEqual({ status: 'deactivated' });

      expect((await client.delete(`/api/saved-views/${created.body.data.id}`)).status).toBe(200);
      expect((await client.get('/api/saved-views?screen=users')).body.data).toHaveLength(1);
    });

    it("never shows or deletes another user's view", async () => {
      const mine = await (await signedInAs(agent)).post('/api/saved-views').send(view());
      const other = await signedInAs(ceo);
      expect((await other.get('/api/saved-views?screen=users')).body.data).toEqual([]);
      expect((await other.delete(`/api/saved-views/${mine.body.data.id}`)).status).toBe(404);
      expect(await SavedView.countDocuments()).toBe(1);
      // The same name is free for another user.
      expect((await other.post('/api/saved-views').send(view())).status).toBe(201);
    });

    it('stores only short, flat filter values', async () => {
      const client = await signedInAs(agent);
      const bad = [
        view({ query: { status: { $ne: 'x' } } }),
        view({ query: { $where: 'x' } }),
        view({ query: { 'a.b': 'x' } }),
        view({ query: { status: 'x'.repeat(201) } }),
        view({ query: Object.fromEntries(Array.from({ length: 31 }, (_, n) => [`f${n}`, 'x'])) }),
        view({ name: '' }),
        view({ screen: 'Users Screen' }),
      ];
      for (const body of bad) {
        expect((await client.post('/api/saved-views').send(body)).status).toBe(400);
      }
      expect((await client.get('/api/saved-views')).status).toBe(400);
      expect((await client.delete('/api/saved-views/not-an-id')).status).toBe(400);
      expect(await SavedView.countDocuments()).toBe(0);
    });

    it('keeps at most 20 views per screen', async () => {
      const client = await signedInAs(agent);
      await SavedView.insertMany(
        Array.from({ length: 20 }, (_, number) => ({
          userId: agent._id,
          screen: 'users',
          name: `View ${number}`,
          query: {},
        })),
      );
      expect((await client.post('/api/saved-views').send(view())).status).toBe(409);
      // Replacing an existing one is still allowed.
      expect((await client.post('/api/saved-views').send(view({ name: 'View 3' }))).status).toBe(
        201,
      );
      expect(await SavedView.countDocuments({ userId: agent._id })).toBe(20);
    });

    it('is removed from the test database between tests', async () => {
      expect(await mongoose.connection.db.collection('saved_views').countDocuments()).toBe(0);
    });
  });
});
