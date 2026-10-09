import { Server } from 'socket.io';
import { logger } from './logger.js';

// Live updates (Socket.IO on the same server, Master Prompt Section 75).
// The server only says "this changed"; it never sends record data over the socket. The browser
// then refetches through the REST API, where every permission check already lives.
//
// Every function here is safe to call when live updates are not running (tests, scripts):
// it then does nothing.

let io = null;

const userRoom = (userId) => `user:${userId}`;

/**
 * Attach Socket.IO to the HTTP server.
 * A socket is accepted only with a valid ticket (lib/realtimeTicket.js, handed out by the API to
 * a signed-in user) and only for a user that is still active. Each socket joins one room: its
 * own user's.
 *
 * @param {import('node:http').Server} httpServer
 * @param {{ verifyTicket: (ticket: unknown) => string | null,
 *           loadUser: (userId: string) => Promise<object|null>,
 *           allowedOrigins?: string[] }} options
 *        verifyTicket: returns the user id of a genuine, unexpired ticket
 *        loadUser: the same function the REST API uses to load the signed-in user
 *        allowedOrigins: addresses of our own client, e.g. ["https://sales.example.com"]
 */
export function startRealtime(httpServer, { verifyTicket, loadUser, allowedOrigins = [] }) {
  // Server is the library's class; it is created once, here.
  io = new Server(httpServer, {
    serveClient: false,
    // Lets our client's pages talk to this address from another address (production).
    cors: { origin: allowedOrigins },
    // A page of another website must not open a connection at all.
    // Browsers always say which page opens a socket (Origin); no Origin means not a browser page.
    allowRequest: (request, callback) => {
      const origin = request.headers.origin;
      const ownOrigins = [`http://${request.headers.host}`, `https://${request.headers.host}`];
      const isAllowed = !origin || allowedOrigins.includes(origin) || ownOrigins.includes(origin);
      callback(null, isAllowed);
    },
  });

  io.use(async (socket, next) => {
    try {
      const userId = verifyTicket(socket.handshake.auth?.ticket);
      const user = userId ? await loadUser(userId) : null;
      if (!user) return next(new Error('unauthorized'));
      socket.data.userId = String(user._id);
      await socket.join(userRoom(socket.data.userId));
      return next();
    } catch (error) {
      logger.warn({ err: error }, 'Socket connection could not be checked');
      return next(new Error('unauthorized'));
    }
  });

  return io;
}

/** Tell every browser of one user that something changed. */
export function emitToUser(userId, event, payload = {}) {
  if (io) io.to(userRoom(String(userId))).emit(event, payload);
}

/** Tell every connected browser that something changed. Never put record data in the payload. */
export function emitToAll(event, payload = {}) {
  if (io) io.emit(event, payload);
}

/** Close every live connection of one user (deactivated, or signed out everywhere). */
export function disconnectUser(userId) {
  if (io) io.in(userRoom(String(userId))).disconnectSockets(true);
}

/** Close all live connections, so the HTTP server can shut down. */
export function stopRealtime() {
  if (!io) return;
  io.disconnectSockets(true);
  io = null;
}
