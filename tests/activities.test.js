import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { createSessionMiddleware } from '../middleware/session.js';
import { Account } from '../models/account.model.js';
import { Activity } from '../models/activity.model.js';
import { AuditLog } from '../models/auditLog.model.js';
import { Opportunity } from '../models/opportunity.model.js';
import { PipelineStage } from '../models/pipelineStage.model.js';
import { Role } from '../models/role.model.js';
import { Task } from '../models/task.model.js';
import { User } from '../models/user.model.js';
import { runSeed, seedStartingLists, seedStatusLists } from '../seeds/seed.js';
import { recordActivity } from '../services/activities.service.js';
import { loadRequestUser } from '../services/auth.service.js';
import { countMyTasks, listTasks } from '../services/tasks.service.js';
import { clearTestDb, startTestDbWithTransactions, stopTestDb } from './helpers/testDb.js';

const PASSWORD = 'correct-horse-battery';
const UNKNOWN_ID = '0123456789abcdef01234567';
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
let leadId;
let stages;

async function signedInAs(user) {
  const client = request.agent(app);
  const response = await client
    .post('/api/auth/login')
    .send({ email: user.email, password: PASSWORD });
  expect(response.status).toBe(200);
  return client;
}

const timeline = async (client, query) => (await client.get(`/api/timeline?${query}`)).body.data;
const titles = async (client, query) => (await timeline(client, query)).map((entry) => entry.title);
const makeTask = async (client, body = {}) =>
  (await client.post('/api/tasks').send({ title: 'Call the plant head', ...body })).body.data;

beforeAll(async () => {
  // Creating a lead and changing its stage use a transaction.
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
  const makeUser = (email, name, roleName, extra = {}) =>
    User.create({
      email,
      name,
      roleId: roles[roleName]._id,
      status: 'active',
      password: PASSWORD,
      ...extra,
    });
  ceo = await makeUser('ceo@engenx.in', 'Kunal CEO', 'CEO');
  manager = await makeUser('manager@engenx.in', 'Meera Manager', 'Sales Manager');
  // The agent reports to the manager; the other agent reports to nobody.
  agent = await makeUser('agent@engenx.in', 'Asha Agent', 'Sales Agent', {
    managerId: manager._id,
  });
  otherAgent = await makeUser('other@engenx.in', 'Omar Agent', 'Sales Agent');
  [asCeo, asManager, asAgent, asOther] = await Promise.all(
    [ceo, manager, agent, otherAgent].map(signedInAs),
  );
  stages = Object.fromEntries(
    (await PipelineStage.find().lean()).map((stage) => [stage.key, stage]),
  );

  // A company and a lead, both of the agent.
  const created = await asAgent.post('/api/accounts/quick-add').send({
    account: { name: 'Bharat Forge' },
    contacts: [{ name: 'Asha Verma' }],
  });
  accountId = created.body.data.account.id;
  contactId = created.body.data.contacts[0].id;
  leadId = (
    await asAgent.post('/api/opportunities').send({ name: 'OEE for press line', accountId })
  ).body.data.id;
});

describe('what the system puts on the timeline', () => {
  it('a new lead, a stage change and an edit each appear once, on the lead and on its company', async () => {
    await asAgent.post(`/api/opportunities/${leadId}/stage`).send({
      stageId: String(stages.lost._id),
      closeReason: 'Price',
      lostToCompetitor: 'Siemens',
    });
    await asAgent.patch(`/api/opportunities/${leadId}`).send({ requirement: 'OEE on 12 presses' });

    const entries = await timeline(asAgent, `opportunityId=${leadId}`);
    expect(entries.map((entry) => [entry.type, entry.subtype, entry.title])).toEqual([
      ['SYSTEM', 'lead_updated', 'Lead updated'],
      ['SYSTEM', 'stage_changed', 'Stage: Lead → Lost'],
      ['SYSTEM', 'lead_created', 'Lead created: OEE for press line'],
    ]);
    expect(entries[1]).toMatchObject({
      content: 'Price',
      user: { name: 'Asha Agent' },
      lead: { name: 'OEE for press line', leadCode: 'EGL-10001' },
      metadata: { from: 'Lead', to: 'Lost', type: 'lost', lostToCompetitor: 'Siemens' },
      canEdit: false,
    });
    expect(entries[0].metadata).toEqual({ fields: ['requirement'] });
    // The company's timeline shows the same entries.
    expect(await titles(asAgent, `accountId=${accountId}`)).toHaveLength(3);
    // An edit that changes nothing adds nothing.
    await asAgent.patch(`/api/opportunities/${leadId}`).send({ requirement: 'OEE on 12 presses' });
    expect(await Activity.countDocuments()).toBe(3);
  });

  it('the same event of the same record is written once; an entry needs something to belong to', async () => {
    const event = {
      type: 'SYSTEM',
      subtype: 'proposal_viewed',
      title: 'Proposal viewed',
      opportunityId: leadId,
      refCollection: 'proposals',
      refId: UNKNOWN_ID,
    };
    const first = await recordActivity(event);
    const again = await recordActivity(event);
    expect(String(again._id)).toBe(String(first._id));
    expect(await Activity.countDocuments({ subtype: 'proposal_viewed' })).toBe(1);
    // The company was filled in from the lead.
    expect(String(first.accountId)).toBe(accountId);
    await expect(recordActivity({ type: 'NOTE', title: 'Nowhere' })).rejects.toThrow(
      /needs a company/,
    );
  });
});

describe('notes', () => {
  it('a note is written on a lead, a company or a contact by someone who may edit it', async () => {
    const before = await Opportunity.findById(leadId).lean();
    const onLead = await asAgent
      .post('/api/notes')
      .send({ opportunityId: leadId, content: '  Met the plant head. Wants a pilot.  ' });
    expect(onLead.status).toBe(201);
    expect(onLead.body.data).toMatchObject({
      type: 'NOTE',
      title: 'Note',
      content: 'Met the plant head. Wants a pilot.',
      user: { name: 'Asha Agent' },
      canEdit: true,
    });
    await asAgent.post('/api/notes').send({ accountId, content: 'Group company of Kalyani.' });
    await asAgent.post('/api/notes').send({ contactId, content: 'Prefers WhatsApp.' });

    // The lead's own timeline has only what is about the lead.
    expect(await titles(asAgent, `opportunityId=${leadId}&type=NOTE`)).toEqual(['Note']);
    const onCompany = await timeline(asAgent, `accountId=${accountId}&type=NOTE`);
    expect(onCompany.map((entry) => entry.content)).toEqual([
      'Prefers WhatsApp.',
      'Group company of Kalyani.',
      'Met the plant head. Wants a pilot.',
    ]);
    expect(onCompany[0].contact).toMatchObject({ name: 'Asha Verma' });
    expect(
      (await timeline(asAgent, `contactId=${contactId}`)).map((entry) => entry.content),
    ).toEqual(['Prefers WhatsApp.']);

    // "Last activity" moved forward, without making the lead look edited (no false stale warning).
    const after = await Opportunity.findById(leadId).lean();
    expect(after.lastActivityAt.getTime()).toBeGreaterThanOrEqual(before.createdAt.getTime());
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect((await Account.findById(accountId).lean()).lastActivityAt).toBeInstanceOf(Date);
    expect(await AuditLog.countDocuments({ action: 'note.created' })).toBe(3);
  });

  it('refuses a note without one clear place, without text, or without sign-in', async () => {
    const cases = [
      { content: 'Nowhere' },
      { accountId, opportunityId: leadId, content: 'Two places' },
      { opportunityId: leadId, content: '   ' },
      { opportunityId: leadId, content: 'x'.repeat(5001) },
      { opportunityId: 'nope', content: 'Bad id' },
    ];
    for (const body of cases) {
      expect(
        (await asAgent.post('/api/notes').send(body)).status,
        JSON.stringify(body).slice(0, 60),
      ).toBe(400);
    }
    expect((await request(app).post('/api/notes').send({ accountId, content: 'x' })).status).toBe(
      401,
    );
    expect((await request(app).get(`/api/timeline?accountId=${accountId}`)).status).toBe(401);
    expect(await Activity.countDocuments({ type: 'NOTE' })).toBe(0);
  });

  it('only its writer changes or removes a note; the change is marked and audited', async () => {
    const note = (
      await asAgent.post('/api/notes').send({ opportunityId: leadId, content: 'First' })
    ).body.data;
    // The CEO sees the note but it is not the CEO's to edit.
    const seenByCeo = (await timeline(asCeo, `opportunityId=${leadId}&type=NOTE`))[0];
    expect(seenByCeo).toMatchObject({ content: 'First', canEdit: false });
    expect((await asCeo.patch(`/api/notes/${note.id}`).send({ content: 'Changed' })).status).toBe(
      404,
    );
    expect((await asCeo.delete(`/api/notes/${note.id}`)).status).toBe(404);

    const edited = await asAgent.patch(`/api/notes/${note.id}`).send({ content: 'Second' });
    expect(edited.body.data.content).toBe('Second');
    expect(edited.body.data.editedAt).toBeTruthy();
    const entry = await AuditLog.findOne({ action: 'note.updated' }).lean();
    expect([entry.oldValue.content, entry.newValue.content]).toEqual(['First', 'Second']);

    // A system entry is not a note: it cannot be edited or removed through the notes API.
    const system = await Activity.findOne({ subtype: 'lead_created' }).lean();
    expect((await asAgent.patch(`/api/notes/${system._id}`).send({ content: 'x' })).status).toBe(
      404,
    );
    expect((await asAgent.delete(`/api/notes/${system._id}`)).status).toBe(404);

    expect((await asAgent.delete(`/api/notes/${note.id}`)).status).toBe(200);
    expect(await Activity.countDocuments({ type: 'NOTE' })).toBe(0);
    expect((await AuditLog.findOne({ action: 'note.deleted' }).lean()).oldValue.content).toBe(
      'Second',
    );
  });
});

describe('the timeline follows the access rules of its record', () => {
  it('nobody reads or writes on a lead or company they may not see', async () => {
    await asAgent.post('/api/notes').send({ opportunityId: leadId, content: 'Private to my lead' });
    for (const query of [
      `opportunityId=${leadId}`,
      `accountId=${accountId}`,
      `contactId=${contactId}`,
    ]) {
      expect((await asOther.get(`/api/timeline?${query}`)).status, query).toBe(404);
    }
    expect(
      (await asOther.post('/api/notes').send({ opportunityId: leadId, content: 'Sneaky' })).status,
    ).toBe(404);
    expect((await asOther.post('/api/notes').send({ accountId, content: 'Sneaky' })).status).toBe(
      404,
    );
    expect((await asAgent.get(`/api/timeline?opportunityId=${UNKNOWN_ID}`)).status).toBe(404);
    expect((await asAgent.get('/api/timeline')).status).toBe(400);
    // The manager of the agent's team may.
    expect((await asManager.get(`/api/timeline?opportunityId=${leadId}`)).status).toBe(200);
  });

  it('a company’s timeline leaves out the entries of leads the person may not see', async () => {
    // On the agent's company, the CEO adds a lead that belongs to the other agent.
    const theirs = (
      await asCeo
        .post('/api/opportunities')
        .send({ name: 'Secret deal', accountId, ownerId: String(otherAgent._id) })
    ).body.data;
    await asCeo
      .post('/api/notes')
      .send({ opportunityId: theirs.id, content: 'Confidential price' });
    await asCeo.post('/api/notes').send({ accountId, content: 'About the company' });

    const forAgent = await timeline(asAgent, `accountId=${accountId}`);
    expect(forAgent.map((entry) => entry.content ?? entry.title)).toEqual([
      'About the company',
      'Lead created: OEE for press line',
    ]);
    expect(JSON.stringify(forAgent)).not.toContain('Secret deal');
    const forCeo = await titles(asCeo, `accountId=${accountId}`);
    expect(forCeo).toContain('Lead created: Secret deal');
    expect(forCeo).toHaveLength(4);
    // Pages: two entries per page, newest first.
    const paged = (await asCeo.get(`/api/timeline?accountId=${accountId}&pageSize=2&page=2`)).body;
    expect(paged.meta).toEqual({ page: 2, pageSize: 2, total: 4 });
    expect(paged.data).toHaveLength(2);
  });
});

describe('tasks', () => {
  it('a task is one’s own by default, can be about a lead, and shows on its timeline', async () => {
    const response = await asAgent.post('/api/tasks').send({
      title: '  Send the proposal ',
      opportunityId: leadId,
      priority: 'high',
      type: 'follow_up',
      dueAt: '2026-10-12T05:30:00.000Z',
    });
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      title: 'Send the proposal',
      status: 'open',
      priority: 'high',
      type: 'follow_up',
      assignee: { name: 'Asha Agent' },
      createdBy: { name: 'Asha Agent' },
      lead: { name: 'OEE for press line' },
      account: { name: 'Bharat Forge' },
      permissions: { canEdit: true, canDelete: true },
    });
    expect(await titles(asAgent, `opportunityId=${leadId}&type=TASK`)).toEqual([
      'Task: Send the proposal',
    ]);

    const plain = await makeTask(asAgent);
    expect(plain).toMatchObject({ priority: 'medium', type: 'task', lead: null, account: null });
    for (const body of [
      { title: '' },
      { title: 'x', priority: 'urgent' },
      { title: 'x', dueAt: 'soon' },
    ]) {
      expect((await asAgent.post('/api/tasks').send(body)).status).toBe(400);
    }
    // A task cannot be hung on a lead the person may not see.
    const hidden = (
      await asCeo.post('/api/opportunities').send({ name: 'Hidden', accountId, ownerId: null })
    ).body.data;
    expect(
      (await asAgent.post('/api/tasks').send({ title: 'x', opportunityId: hidden.id })).status,
    ).toBe(404);
  });

  it('giving a task to someone else needs the assign permission, inside its scope', async () => {
    const byAgent = await asAgent
      .post('/api/tasks')
      .send({ title: 'x', assigneeId: String(otherAgent._id) });
    expect(byAgent.status).toBe(403);
    // A manager assigns inside their own team only.
    const toTeam = await asManager
      .post('/api/tasks')
      .send({ title: 'Call back', assigneeId: String(agent._id) });
    expect(toTeam.status).toBe(201);
    expect(toTeam.body.data).toMatchObject({
      assignee: { name: 'Asha Agent' },
      createdBy: { name: 'Meera Manager' },
    });
    expect(
      (await asManager.post('/api/tasks').send({ title: 'x', assigneeId: String(otherAgent._id) }))
        .status,
    ).toBe(403);
    expect(
      (await asCeo.post('/api/tasks').send({ title: 'x', assigneeId: String(otherAgent._id) }))
        .status,
    ).toBe(201);
    expect(
      (await asCeo.post('/api/tasks').send({ title: 'x', assigneeId: UNKNOWN_ID })).status,
    ).toBe(400);

    const options = (await asManager.get('/api/tasks/form-options')).body.data;
    expect(options.users.map((user) => user.name)).toEqual(['Asha Agent', 'Meera Manager']);
    expect((await asAgent.get('/api/tasks/form-options')).body.data).toMatchObject({
      canAssign: false,
      users: [{ name: 'Asha Agent' }],
    });
  });

  it('who sees which task', async () => {
    const mine = await makeTask(asAgent, { title: 'Agent’s own' });
    const others = await makeTask(asOther, { title: 'Other agent’s own' });
    const fromManager = await makeTask(asManager, {
      title: 'From the manager',
      assigneeId: String(agent._id),
    });
    const seenBy = async (client) =>
      (await client.get('/api/tasks?view=all')).body.data.map((task) => task.title).sort();

    expect(await seenBy(asAgent)).toEqual(['Agent’s own', 'From the manager']);
    expect(await seenBy(asOther)).toEqual(['Other agent’s own']);
    // The manager: their team's tasks and the ones they created.
    expect(await seenBy(asManager)).toEqual(['Agent’s own', 'From the manager']);
    expect(await seenBy(asCeo)).toHaveLength(3);

    expect((await asOther.get(`/api/tasks/${mine.id}`)).status).toBe(404);
    expect((await asOther.patch(`/api/tasks/${mine.id}`).send({ title: 'Hacked' })).status).toBe(
      404,
    );
    expect((await asAgent.delete(`/api/tasks/${others.id}`)).status).toBe(404);
    // The assignee completes a task the manager gave them; the manager who created it sees it.
    expect(
      (await asAgent.patch(`/api/tasks/${fromManager.id}`).send({ status: 'done' })).status,
    ).toBe(200);
    expect((await asManager.get(`/api/tasks/${fromManager.id}`)).body.data.status).toBe('done');
    expect((await request(app).get('/api/tasks')).status).toBe(401);
  });

  it('a task about a lead is seen by whoever may see the lead, and by nobody else', async () => {
    // The CEO hangs a task for the other agent on the agent's lead.
    const task = await makeTask(asCeo, {
      opportunityId: leadId,
      assigneeId: String(otherAgent._id),
    });
    // Everyone who sees the lead sees its tasks.
    const onLead = async (client) =>
      (await client.get(`/api/tasks?view=all&opportunityId=${leadId}`)).body;
    expect((await onLead(asAgent)).data.map((item) => item.id)).toEqual([task.id]);
    expect((await asManager.get(`/api/tasks/${task.id}`)).status).toBe(200);
    // The other agent may not see that lead: not its task list, and not this task about it,
    // even though it is assigned to them (the lead access rule comes first).
    expect((await asOther.get(`/api/tasks?view=all&opportunityId=${leadId}`)).status).toBe(404);
    expect((await asOther.get(`/api/tasks/${task.id}`)).status).toBe(404);
    // The agent sees the task but may not change someone else's.
    expect((await asAgent.patch(`/api/tasks/${task.id}`).send({ title: 'Mine now' })).status).toBe(
      403,
    );
  });

  it('Today, Upcoming, Overdue and Completed use the days of India', async () => {
    // "Now" is 12:00 in India on 10 October 2026.
    const now = new Date('2026-10-10T06:30:00.000Z');
    const actor = await loadRequestUser(agent._id);
    const due = (title, dueAt, extra = {}) =>
      Task.create({ title, dueAt, assigneeId: agent._id, createdBy: agent._id, ...extra });
    await due('Yesterday 23:30 IST', new Date('2026-10-09T18:00:00.000Z'));
    await due('Today 00:15 IST', new Date('2026-10-09T18:45:00.000Z'), { priority: 'low' });
    await due('Today 23:45 IST', new Date('2026-10-10T18:15:00.000Z'));
    await due('Tomorrow 00:05 IST', new Date('2026-10-10T18:35:00.000Z'));
    await due('No date', undefined);
    await due('Done yesterday', new Date('2026-10-09T10:00:00.000Z'), {
      status: 'done',
      completedAt: new Date('2026-10-09T11:00:00.000Z'),
    });

    const names = async (view) =>
      (await listTasks(actor, { view, page: 1, pageSize: 50 }, now)).items.map(
        (task) => task.title,
      );
    expect(await names('overdue')).toEqual(['Yesterday 23:30 IST']);
    expect(await names('today')).toEqual(['Today 00:15 IST', 'Today 23:45 IST']);
    expect(await names('upcoming')).toEqual(['Tomorrow 00:05 IST', 'No date']);
    expect(await names('completed')).toEqual(['Done yesterday']);
    expect(await names('open')).toHaveLength(5);
    expect(await countMyTasks(actor, now)).toEqual({ today: 2, overdue: 1, upcoming: 2 });

    const overdue = (await listTasks(actor, { view: 'overdue', page: 1, pageSize: 5 }, now))
      .items[0];
    expect(overdue.isOverdue).toBe(true);
  });

  it('completing records the time and one timeline entry; reopening clears the time', async () => {
    const task = await makeTask(asAgent, { opportunityId: leadId });
    const done = await asAgent.patch(`/api/tasks/${task.id}`).send({ status: 'done' });
    expect(done.body.data.status).toBe('done');
    expect(done.body.data.completedAt).toBeTruthy();
    expect((await asAgent.get('/api/tasks?view=completed')).body.data).toHaveLength(1);
    expect((await asAgent.get('/api/tasks?view=open')).body.data).toHaveLength(0);

    const reopened = await asAgent
      .patch(`/api/tasks/${task.id}`)
      .send({ status: 'open', priority: 'high' });
    expect(reopened.body.data).toMatchObject({
      status: 'open',
      completedAt: null,
      priority: 'high',
    });
    await asAgent.patch(`/api/tasks/${task.id}`).send({ status: 'done' });
    expect(await titles(asAgent, `opportunityId=${leadId}&type=TASK`)).toEqual([
      'Task done: Call the plant head',
      'Task: Call the plant head',
    ]);
    const actions = (await AuditLog.find({ entityType: 'tasks' }).sort({ _id: 1 }).lean()).map(
      (entry) => entry.action,
    );
    expect(actions).toEqual(['task.created', 'task.completed', 'task.updated', 'task.completed']);

    expect((await asAgent.delete(`/api/tasks/${task.id}`)).status).toBe(200);
    expect(await Task.countDocuments()).toBe(0);
  });
});
