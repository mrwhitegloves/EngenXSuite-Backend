import { createServer } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { io as connectSocket } from 'socket.io-client';
import { createApp } from '../app.js';
import { createSessionMiddleware } from '../middleware/session.js';
import { Role } from '../models/role.model.js';
import { User } from '../models/user.model.js';
import { runSeed } from '../seeds/seed.js';
import { loadRequestUser } from '../services/auth.service.js';
import { emitToAll, emitToUser, startRealtime, stopRealtime } from '../infra/realtime.js';
import { SOCKET_EVENTS } from '../constants/socketEvents.js';
import { TICKET_LIFETIME_SECONDS, createTicket, verifyTicket } from '../lib/realtimeTicket.js';
import { clearTestDb, startTestDb, stopTestDb } from './helpers/testDb.js';

// A real HTTP server on a free port with real sockets: the same wiring as index.js.

const PASSWORD = 'correct-horse-battery';
let httpServer;
let baseUrl;
let roles;
let ceo;
let agent;
let otherAgent;
let sockets = [];

/** Sign in through the API; returns the supertest client and its session cookie. */
async function signIn(user) {
  const client = request.agent(baseUrl);
  const response = await client
    .post('/api/auth/login')
    .send({ email: user.email, password: PASSWORD });
  expect(response.status).toBe(200);
  const cookie = response.headers['set-cookie'].map((value) => value.split(';')[0]).join('; ');
  return { client, cookie };
}

/** Ask the API for a connection ticket, as the browser does. null when the API refuses. */
async function fetchTicket(cookie) {
  const response = await request(baseUrl)
    .get('/api/realtime/ticket')
    .set(cookie ? { Cookie: cookie } : {});
  return response.status === 200 ? response.body.data.ticket : null;
}

/** Connect with exactly this ticket (or none). */
function connectWithTicket(ticket, origin) {
  const socket = connectSocket(baseUrl, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    auth: ticket ? { ticket } : {},
    extraHeaders: origin ? { Origin: origin } : {},
  });
  sockets.push(socket);
  socket.received = [];
  socket.onAny((event, payload) => socket.received.push({ event, payload }));
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (error) => reject(error));
  });
}

/**
 * Open a socket the way the browser does: with this session cookie, get a ticket from the API,
 * then connect with it. Resolves with the socket, rejects when the server refuses.
 */
async function openSocket(cookie, origin) {
  return connectWithTicket(await fetchTicket(cookie), origin);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const eventsOf = (socket) => socket.received.map((item) => item.event);

beforeAll(async () => {
  // Before anything is started, the helpers must simply do nothing.
  expect(() => emitToAll('x')).not.toThrow();
  expect(() => emitToUser('u1', 'x')).not.toThrow();

  await startTestDb();
  const sessionMiddleware = createSessionMiddleware();
  httpServer = createServer(createApp({ sessionMiddleware }));
  startRealtime(httpServer, {
    verifyTicket,
    loadUser: loadRequestUser,
    allowedOrigins: ['https://client.example'],
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

afterAll(async () => {
  stopRealtime();
  await new Promise((resolve) => httpServer.close(resolve));
  await stopTestDb();
});

beforeEach(async () => {
  await clearTestDb();
  await runSeed({ productName: 'P', companyName: 'C', workspaceDomain: 'engenx.in' });
  roles = Object.fromEntries((await Role.find()).map((role) => [role.name, role]));
  const makeUser = (email, roleName) =>
    User.create({
      email,
      name: email,
      roleId: roles[roleName]._id,
      status: 'active',
      password: PASSWORD,
    });
  ceo = await makeUser('ceo@engenx.in', 'CEO');
  agent = await makeUser('agent@engenx.in', 'Sales Agent');
  otherAgent = await makeUser('other@engenx.in', 'Sales Agent');
});

afterEach(() => {
  sockets.forEach((socket) => socket.close());
  sockets = [];
});

describe('live updates (Socket.IO)', () => {
  it('refuses a connection without a session, or with a made-up cookie', async () => {
    await expect(openSocket(null)).rejects.toThrow('unauthorized');
    await expect(openSocket('sid=s%3Anot-a-real-session.signature')).rejects.toThrow(
      'unauthorized',
    );
  });

  it('accepts a signed-in user', async () => {
    const { cookie } = await signIn(agent);
    const socket = await openSocket(cookie);
    expect(socket.connected).toBe(true);
  });

  it('a ticket is only given to a signed-in user, and names the place to connect to', async () => {
    expect((await request(baseUrl).get('/api/realtime/ticket')).status).toBe(401);
    const { client } = await signIn(agent);
    const response = await client.get('/api/realtime/ticket');
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ url: null, expiresInSeconds: 60 });
    expect(verifyTicket(response.body.data.ticket)).toBe(String(agent._id));
  });

  it('the session cookie alone does not open a connection: a ticket is needed', async () => {
    const { cookie } = await signIn(agent);
    const socket = connectSocket(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      extraHeaders: { Cookie: cookie },
    });
    sockets.push(socket);
    const error = await new Promise((resolve) => socket.once('connect_error', resolve));
    expect(error.message).toBe('unauthorized');
  });

  it('refuses a forged, changed or expired ticket', async () => {
    const good = createTicket(String(agent._id));
    const [userId, expiresAt, signature] = good.split('.');
    const longAgo = Date.now() - (TICKET_LIFETIME_SECONDS + 5) * 1000;

    for (const ticket of [
      `${otherAgent._id}.${expiresAt}.${signature}`, // another user's id with this signature
      `${userId}.${Number(expiresAt) + 60_000}.${signature}`, // a later expiry
      `${userId}.${expiresAt}.${'A'.repeat(signature.length)}`,
      `${userId}.${expiresAt}`,
      'not-a-ticket',
      createTicket(String(agent._id), longAgo), // genuine but expired
    ]) {
      await expect(connectWithTicket(ticket), ticket.slice(0, 30)).rejects.toThrow('unauthorized');
    }
    expect((await connectWithTicket(good)).connected).toBe(true);
  });

  it('a genuine ticket of a user who was deactivated since is refused', async () => {
    const ticket = createTicket(String(agent._id));
    await User.updateOne({ _id: agent._id }, { $set: { status: 'deactivated' } });
    await expect(connectWithTicket(ticket)).rejects.toThrow('unauthorized');
  });

  it("a page of another website cannot open a connection, even with the user's cookie", async () => {
    const { cookie } = await signIn(agent);
    await expect(openSocket(cookie, 'https://evil.example')).rejects.toThrow();
    await expect(openSocket(cookie, 'https://client.example.evil.example')).rejects.toThrow();
    // Our own client address, and the address the server itself is reached at, are allowed.
    expect((await openSocket(cookie, 'https://client.example')).connected).toBe(true);
    expect((await openSocket(cookie, baseUrl)).connected).toBe(true);
  });

  it('an event for one user reaches only that user, on all of their browsers', async () => {
    const first = await openSocket((await signIn(agent)).cookie);
    const second = await openSocket((await signIn(agent)).cookie);
    const other = await openSocket((await signIn(otherAgent)).cookie);

    emitToUser(agent._id, 'demo.changed', { id: 'abc' });
    await wait(150);

    expect(first.received).toEqual([{ event: 'demo.changed', payload: { id: 'abc' } }]);
    expect(second.received).toHaveLength(1);
    expect(other.received).toEqual([]);
  });

  it('an event for everyone reaches every signed-in user', async () => {
    const first = await openSocket((await signIn(agent)).cookie);
    const other = await openSocket((await signIn(otherAgent)).cookie);
    emitToAll('demo.changed');
    await wait(150);
    expect(eventsOf(first)).toEqual(['demo.changed']);
    expect(eventsOf(other)).toEqual(['demo.changed']);
  });

  it('a browser cannot send events to other users through the server', async () => {
    const first = await openSocket((await signIn(agent)).cookie);
    const other = await openSocket((await signIn(otherAgent)).cookie);
    first.emit(SOCKET_EVENTS.permissionsChanged, { forged: true });
    first.emit('join', `user:${otherAgent._id}`);
    emitToUser(otherAgent._id, 'demo.changed');
    await wait(150);
    expect(eventsOf(other)).toEqual(['demo.changed']);
    expect(first.received).toEqual([]);
  });

  it('editing a user tells that user "you changed" and everyone "users changed", without data', async () => {
    const { client } = await signIn(ceo);
    const ceoSocket = await openSocket((await signIn(ceo)).cookie);
    const agentSocket = await openSocket((await signIn(agent)).cookie);
    const otherSocket = await openSocket((await signIn(otherAgent)).cookie);

    const response = await client.patch(`/api/users/${agent._id}`).send({ name: 'New Name' });
    expect(response.status).toBe(200);
    await wait(150);

    expect(eventsOf(agentSocket).sort()).toEqual([
      SOCKET_EVENTS.meChanged,
      SOCKET_EVENTS.usersChanged,
    ]);
    expect(eventsOf(otherSocket)).toEqual([SOCKET_EVENTS.usersChanged]);
    expect(eventsOf(ceoSocket)).toEqual([SOCKET_EVENTS.usersChanged]);
    // Nothing about the record travels over the socket.
    expect(JSON.stringify(agentSocket.received)).not.toContain('New Name');
    expect(agentSocket.received.every((item) => Object.keys(item.payload).length === 0)).toBe(true);
  });

  it('changing permissions tells every browser', async () => {
    const { client } = await signIn(ceo);
    const agentSocket = await openSocket((await signIn(agent)).cookie);

    const response = await client
      .patch(`/api/roles/${roles['Sales Agent']._id}`)
      .send({ grants: [{ feature: 'accounts', action: 'view', scope: 'own' }] });
    expect(response.status).toBe(200);
    await wait(150);
    expect(eventsOf(agentSocket)).toEqual([SOCKET_EVENTS.permissionsChanged]);
  });

  it('deactivating a user closes their live connection and refuses a new one', async () => {
    const { client } = await signIn(ceo);
    const { cookie } = await signIn(agent);
    const agentSocket = await openSocket(cookie);
    const otherSocket = await openSocket((await signIn(otherAgent)).cookie);

    const response = await client.patch(`/api/users/${agent._id}`).send({ status: 'deactivated' });
    expect(response.status).toBe(200);
    await wait(200);

    expect(agentSocket.connected).toBe(false);
    expect(otherSocket.connected).toBe(true);
    await expect(openSocket(cookie)).rejects.toThrow('unauthorized');
  });

  it('after signing out, the old cookie no longer opens a connection', async () => {
    const { client, cookie } = await signIn(agent);
    expect((await client.post('/api/auth/logout')).status).toBe(200);
    await expect(openSocket(cookie)).rejects.toThrow('unauthorized');
  });
});
