import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { createSessionMiddleware } from '../middleware/session.js';
import { Notification } from '../models/notification.model.js';
import { Role } from '../models/role.model.js';
import { Task } from '../models/task.model.js';
import { User } from '../models/user.model.js';
import { runSeed, seedStartingLists, seedStatusLists } from '../seeds/seed.js';
import { notify } from '../services/notifications.service.js';
import { runTaskReminders } from '../services/taskReminders.service.js';
import { clearTestDb, startTestDbWithTransactions, stopTestDb } from './helpers/testDb.js';

const PASSWORD = 'correct-horse-battery';
let app;
let ceo;
let agent;
let otherAgent;
let asCeo;
let asAgent;
let asOther;

async function signedInAs(user) {
  const client = request.agent(app);
  const response = await client
    .post('/api/auth/login')
    .send({ email: user.email, password: PASSWORD });
  expect(response.status).toBe(200);
  return client;
}

const inbox = async (client, query = '') =>
  (await client.get(`/api/notifications${query}`)).body.data;
const unread = async (client) =>
  (await client.get('/api/notifications/unread-count')).body.data.unread;

beforeAll(async () => {
  // Creating a lead uses a transaction.
  await startTestDbWithTransactions();
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
  agent = await makeUser('agent@engenx.in', 'Asha Agent', 'Sales Agent');
  otherAgent = await makeUser('other@engenx.in', 'Omar Agent', 'Sales Agent');
  [asCeo, asAgent, asOther] = await Promise.all([ceo, agent, otherAgent].map(signedInAs));
});

describe('what creates a notification', () => {
  it('a task or a lead given to someone tells that person, and only that person', async () => {
    await asCeo
      .post('/api/tasks')
      .send({ title: 'Call the plant head', assigneeId: String(agent._id) });
    const account = (await asCeo.post('/api/accounts').send({ name: 'Bharat Forge' })).body.data;
    const lead = (
      await asCeo
        .post('/api/opportunities')
        .send({ name: 'OEE for press line', accountId: account.id, ownerId: String(agent._id) })
    ).body.data;

    const forAgent = await inbox(asAgent);
    expect(forAgent.map((item) => [item.type, item.title, item.body, item.link])).toEqual([
      ['lead_assigned', 'Kunal CEO gave you a lead', 'OEE for press line', `/pipeline/${lead.id}`],
      ['task_assigned', 'Kunal CEO gave you a task', 'Call the plant head', '/activities'],
    ]);
    expect(forAgent.every((item) => item.isRead === false)).toBe(true);
    expect(await unread(asAgent)).toBe(2);
    // Nobody else is told, and nobody is told about what they did themselves.
    expect(await inbox(asOther)).toEqual([]);
    expect(await inbox(asCeo)).toEqual([]);
    await asAgent.post('/api/tasks').send({ title: 'My own task' });
    expect(await unread(asAgent)).toBe(2);

    // Reassigning tells the new person, not the one who already had it.
    await asCeo.patch(`/api/opportunities/${lead.id}`).send({
      ownerId: String(otherAgent._id),
      assignedUserIds: [String(agent._id)],
    });
    expect((await inbox(asOther)).map((item) => item.type)).toEqual(['lead_assigned']);
    expect(await unread(asAgent)).toBe(2);
  });

  it('the same thing is told once; an unknown kind or a deactivated person gets nothing', async () => {
    const message = {
      userId: agent._id,
      type: 'task_overdue',
      title: 'Overdue: X',
      dedupeKey: 'task-overdue:x:1',
    };
    expect(await notify(message)).toMatchObject({ title: 'Overdue: X', isRead: false });
    expect(await notify(message)).toBeNull();
    expect(await notify({ ...message, dedupeKey: 'k2', type: 'nonsense' })).toBeNull();
    await User.updateOne({ _id: otherAgent._id }, { $set: { status: 'deactivated' } });
    expect(await notify({ ...message, userId: otherAgent._id })).toBeNull();
    expect(await Notification.countDocuments()).toBe(1);
  });
});

describe('preferences', () => {
  it('with notifications switched off nothing is stored, and switching on brings nothing back', async () => {
    const before = (await asAgent.get('/api/notifications/preferences')).body.data;
    expect(before.enabled).toBe(true);
    expect(before.types.map((item) => [item.type, item.enabled])).toEqual([
      ['task_assigned', true],
      ['task_reminder', true],
      ['task_overdue', true],
      ['lead_assigned', true],
    ]);

    await asAgent.patch('/api/notifications/preferences').send({ enabled: false });
    await asCeo.post('/api/tasks').send({ title: 'While off', assigneeId: String(agent._id) });
    expect(await Notification.countDocuments()).toBe(0);

    await asAgent.patch('/api/notifications/preferences').send({ enabled: true });
    expect(await inbox(asAgent)).toEqual([]);

    // One kind off: that kind is not created, the others are.
    const changed = await asAgent
      .patch('/api/notifications/preferences')
      .send({ types: { task_assigned: false } });
    expect(changed.body.data.types[0]).toMatchObject({ type: 'task_assigned', enabled: false });
    await asCeo.post('/api/tasks').send({ title: 'Kind is off', assigneeId: String(agent._id) });
    expect(
      await notify({ userId: agent._id, type: 'task_overdue', title: 'Still on' }),
    ).not.toBeNull();
    expect((await inbox(asAgent)).map((item) => item.title)).toEqual(['Still on']);

    expect(
      (await asAgent.patch('/api/notifications/preferences').send({ types: { nonsense: true } }))
        .status,
    ).toBe(400);
    expect((await asAgent.patch('/api/notifications/preferences').send({})).status).toBe(400);
  });
});

describe('reading', () => {
  it('a person reads, filters and marks only their own notifications', async () => {
    for (const title of ['First', 'Second', 'Third']) {
      await notify({ userId: agent._id, type: 'task_reminder', title, body: 'Due soon' });
    }
    await notify({ userId: otherAgent._id, type: 'task_overdue', title: 'For Omar' });
    const mine = await inbox(asAgent);
    expect(mine.map((item) => item.title)).toEqual(['Third', 'Second', 'First']);

    const read = await asAgent.post(`/api/notifications/${mine[0].id}/read`);
    expect(read.body.data.isRead).toBe(true);
    expect(await unread(asAgent)).toBe(2);
    expect((await inbox(asAgent, '?unread=true')).map((item) => item.title)).toEqual([
      'Second',
      'First',
    ]);
    expect((await inbox(asAgent, '?search=seco')).map((item) => item.title)).toEqual(['Second']);
    expect(await inbox(asAgent, '?type=task_overdue')).toEqual([]);
    expect((await asAgent.get('/api/notifications?pageSize=2')).body.meta).toEqual({
      page: 1,
      pageSize: 2,
      total: 3,
    });

    // Someone else's notification cannot be read or marked.
    const omars = (await inbox(asOther))[0];
    expect((await asAgent.post(`/api/notifications/${omars.id}/read`)).status).toBe(404);
    expect((await asAgent.post('/api/notifications/read-all')).body.data.marked).toBe(2);
    expect(await unread(asAgent)).toBe(0);
    expect(await unread(asOther)).toBe(1);
    expect((await request(app).get('/api/notifications')).status).toBe(401);
  });
});

describe('task reminders', () => {
  // "Now" is 12:00 in India on 10 October 2026.
  const now = new Date('2026-10-10T06:30:00.000Z');
  const minutes = (count) => new Date(now.getTime() + count * 60_000);
  const task = (title, fields) =>
    Task.create({ title, assigneeId: agent._id, createdBy: ceo._id, ...fields });

  it('reminds before the due time, tells about overdue tasks, and each only once', async () => {
    await task('Due in 20 minutes', { dueAt: minutes(20) });
    await task('Due in 2 hours', { dueAt: minutes(120) });
    await task('Own reminder time', { dueAt: minutes(300), remindAt: minutes(-1) });
    await task('Overdue since an hour', { dueAt: minutes(-60) });
    await task('Done already', { dueAt: minutes(-60), status: 'done' });
    await task('No date', {});

    expect(await runTaskReminders(now)).toEqual({ reminded: 2, overdue: 1 });
    const titles = (await inbox(asAgent)).map((item) => item.title).sort();
    expect(titles).toEqual([
      'Overdue: Overdue since an hour',
      'Reminder: Due in 20 minutes',
      'Reminder: Own reminder time',
    ]);
    // A second run (the job ran twice, or a minute later) tells nothing again.
    expect(await runTaskReminders(now)).toEqual({ reminded: 0, overdue: 0 });
    expect(await runTaskReminders(minutes(1))).toEqual({ reminded: 0, overdue: 0 });
    expect(await Notification.countDocuments()).toBe(3);

    // Later: the 20-minute task is overdue now, the 2-hour task comes up for its reminder.
    expect(await runTaskReminders(minutes(95))).toEqual({ reminded: 1, overdue: 1 });
    expect(await Notification.countDocuments()).toBe(5);
  });

  it('a new due time is told about again; a reminder link opens the lead when there is one', async () => {
    const account = (await asCeo.post('/api/accounts').send({ name: 'Bharat Forge' })).body.data;
    const lead = (
      await asCeo.post('/api/opportunities').send({ name: 'OEE', accountId: account.id })
    ).body.data;
    const created = (
      await asCeo.post('/api/tasks').send({
        title: 'Send the proposal',
        opportunityId: lead.id,
        assigneeId: String(agent._id),
        dueAt: minutes(10).toISOString(),
      })
    ).body.data;
    await runTaskReminders(now);
    const reminder = (await inbox(asAgent, '?type=task_reminder'))[0];
    expect(reminder).toMatchObject({
      title: 'Reminder: Send the proposal',
      link: `/pipeline/${lead.id}`,
    });
    expect(reminder.body).toMatch(/^Due 10 Oct 2026/);

    // The task is moved to later: when that time comes near, the person is reminded again.
    await asCeo.patch(`/api/tasks/${created.id}`).send({ dueAt: minutes(200).toISOString() });
    expect(await runTaskReminders(minutes(20))).toEqual({ reminded: 0, overdue: 0 });
    expect(await runTaskReminders(minutes(175))).toEqual({ reminded: 1, overdue: 0 });
    expect(await inbox(asAgent, '?type=task_reminder')).toHaveLength(2);
  });
});
