import { createAppError } from '../../lib/errors.js';

// The only file that talks to the Gmail API. Every function takes a working access token of
// one person (from getGoogleAccessToken) and works on THEIR mailbox only ("users/me").
// What is read and what is kept is decided by services/emailSync.service.js.

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

async function call(token, path, { method = 'GET', body, query } = {}) {
  const url = new URL(`${BASE}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    for (const item of [value].flat()) {
      if (item !== undefined && item !== null) url.searchParams.append(key, String(item));
    }
  }
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw createAppError('GOOGLE_UNREACHABLE', 502, 'Gmail could not be reached. Try again.');
  }
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = createAppError(
      response.status === 404 ? 'GMAIL_NOT_FOUND' : 'GMAIL_ERROR',
      response.status === 404 ? 404 : 502,
      `Gmail refused the request: ${String(answer?.error?.message ?? response.status).slice(0, 200)}`,
    );
    throw error;
  }
  return answer;
}

/** The mailbox's address and the point its history stands at now. */
export async function getMailboxProfile(token) {
  const profile = await call(token, '/profile');
  return {
    email: String(profile.emailAddress).toLowerCase(),
    historyId: String(profile.historyId),
  };
}

/**
 * The ids of messages that match a Gmail search, newest first.
 * @returns {Promise<{ ids: { id: string, threadId: string }[], nextPageToken?: string }>}
 */
export async function listMessageIds(token, { search, pageToken, pageSize = 100 }) {
  const page = await call(token, '/messages', {
    query: { q: search, maxResults: pageSize, pageToken },
  });
  return { ids: page.messages ?? [], nextPageToken: page.nextPageToken };
}

/**
 * The ids of messages that arrived or were sent after a point of the mailbox's history.
 * Throws GMAIL_NOT_FOUND when that point is too old for Gmail (about a week).
 * @returns {Promise<{ ids: { id: string, threadId: string }[], historyId: string }>}
 */
export async function listNewMessageIds(token, startHistoryId) {
  const ids = new Map();
  let pageToken;
  let historyId = String(startHistoryId);
  do {
    const page = await call(token, '/history', {
      query: { startHistoryId, historyTypes: 'messageAdded', pageToken },
    });
    for (const entry of page.history ?? []) {
      for (const added of entry.messagesAdded ?? []) {
        ids.set(added.message.id, { id: added.message.id, threadId: added.message.threadId });
      }
    }
    historyId = String(page.historyId ?? historyId);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return { ids: [...ids.values()], historyId };
}

const headerOf = (message, name) =>
  message.payload?.headers?.find((header) => header.name.toLowerCase() === name.toLowerCase())
    ?.value ?? '';

/** Every email address in a header value: "Asha <a@b.in>, c@d.in" → ["a@b.in", "c@d.in"]. */
export const addressesIn = (value) =>
  [...String(value ?? '').matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map((match) =>
    match[0].toLowerCase(),
  );

/** "Asha Verma <a@b.in>" → "Asha Verma"; an address alone → null. */
const nameIn = (value) => {
  const name = String(value ?? '')
    .split('<')[0]
    .replace(/["']/g, '')
    .trim();
  return name && !name.includes('@') ? name : null;
};

/**
 * Who a message is from and to, WITHOUT its text: enough to decide whether it is kept.
 * @returns {Promise<{ id: string, threadId: string, from: string | null, to: string[], cc: string[],
 *                     labels: string[] }>}
 */
export async function getMessageParties(token, id) {
  const message = await call(token, `/messages/${id}`, {
    query: { format: 'metadata', metadataHeaders: ['From', 'To', 'Cc'] },
  });
  return {
    id: message.id,
    threadId: message.threadId,
    from: addressesIn(headerOf(message, 'From'))[0] ?? null,
    to: addressesIn(headerOf(message, 'To')),
    cc: addressesIn(headerOf(message, 'Cc')),
    labels: message.labelIds ?? [],
  };
}

const decode = (data) => Buffer.from(String(data ?? ''), 'base64url').toString('utf8');
const htmlToText = (html) =>
  html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** The readable text of a message (plain text when it has one), and its attachments' names. */
function readParts(payload) {
  let plain = '';
  let html = '';
  const attachments = [];
  const walk = (part) => {
    if (!part) return;
    if (part.filename) {
      attachments.push({
        filename: part.filename.slice(0, 200),
        mimeType: part.mimeType ?? '',
        size: Number(part.body?.size ?? 0),
      });
    } else if (part.mimeType === 'text/plain' && part.body?.data) {
      plain += decode(part.body.data);
    } else if (part.mimeType === 'text/html' && part.body?.data) {
      html += decode(part.body.data);
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  return { text: (plain.trim() || htmlToText(html)).trim(), attachments };
}

/**
 * One message in full.
 * @returns {Promise<{ id, threadId, from, fromName, to, cc, subject, sentAt: Date, snippet,
 *                     text, attachments, labels, messageIdHeader, references }>}
 */
export async function getMessage(token, id) {
  const message = await call(token, `/messages/${id}`, { query: { format: 'full' } });
  const { text, attachments } = readParts(message.payload);
  const from = headerOf(message, 'From');
  return {
    id: message.id,
    threadId: message.threadId,
    from: addressesIn(from)[0] ?? null,
    fromName: nameIn(from),
    to: addressesIn(headerOf(message, 'To')),
    cc: addressesIn(headerOf(message, 'Cc')),
    subject: headerOf(message, 'Subject').slice(0, 500),
    sentAt: new Date(Number(message.internalDate ?? Date.now())),
    snippet: String(message.snippet ?? '').slice(0, 300),
    text,
    attachments,
    labels: message.labelIds ?? [],
    messageIdHeader: headerOf(message, 'Message-ID') || headerOf(message, 'Message-Id'),
    references: headerOf(message, 'References'),
  };
}

const encodeWord = (text) =>
  /^[\x20-\x7e]*$/.test(text)
    ? text
    : `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;

/**
 * Send a plain-text message from the person's own mailbox. With `threadId` (and the id header
 * of the message it answers) it lands in that conversation.
 * @param {{ from: string, to: string[], cc?: string[], subject: string, text: string,
 *           threadId?: string, inReplyTo?: string, references?: string }} mail
 * @returns {Promise<{ id: string, threadId: string }>}
 */
export async function sendMessage(token, mail) {
  const lines = [
    `From: ${mail.from}`,
    `To: ${mail.to.join(', ')}`,
    mail.cc?.length ? `Cc: ${mail.cc.join(', ')}` : null,
    `Subject: ${encodeWord(mail.subject)}`,
    mail.inReplyTo ? `In-Reply-To: ${mail.inReplyTo}` : null,
    mail.inReplyTo
      ? `References: ${[mail.references, mail.inReplyTo].filter(Boolean).join(' ')}`
      : null,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(mail.text, 'utf8')
      .toString('base64')
      .replace(/(.{76})/g, '$1\r\n'),
  ].filter((line) => line !== null);
  const sent = await call(token, '/messages/send', {
    method: 'POST',
    body: {
      raw: Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url'),
      ...(mail.threadId ? { threadId: mail.threadId } : {}),
    },
  });
  return { id: sent.id, threadId: sent.threadId };
}
