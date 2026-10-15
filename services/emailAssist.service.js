import {
  extractEmailTasks,
  reviewEmail,
  suggestMeeting,
  summarizeDocument,
  summarizeThread,
  writeEmailVariants,
} from '../ai/tasks/emailAssist.js';
import { keyFromUrl, readObject } from '../infra/storage.js';
import { badRequest, notFound } from '../lib/errors.js';
import { Account } from '../models/account.model.js';
import { Contact } from '../models/contact.model.js';
import { Email, EmailThread } from '../models/email.model.js';
import { readChatFile } from './aiChat.service.js';
import { loadThreadForViewer, visibleThreads } from './emails.service.js';
import { responsibleFor } from './emailSync.service.js';
import { notify } from './notifications.service.js';

// The AI's smaller helps on customer mail (ai/tasks/emailAssist.js), and the reminder that a
// mail of ours got no answer. Nothing here sends a mail or changes a record: a person reads
// the AI's answer and decides (a task or a meeting is made by the normal screens).

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_READ_BYTES = 10 * 1024 * 1024;
// A mail of ours without an answer is brought up after this many days, once each.
export const FOLLOW_UP_DAYS = [3, 7];

/** Today in India, as the AI needs it to work out "Friday" or "next week". */
function todayInIndia(now) {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    weekday: 'long',
  }).format(now);
  return `${date} (${weekday})`;
}

async function conversationOf(thread) {
  const emails = await Email.find({ threadId: thread._id }).sort({ sentAt: -1 }).limit(15).lean();
  return emails.reverse().map((email) => ({
    direction: email.direction,
    from: email.fromName ?? email.from,
    date: email.sentAt.toISOString().slice(0, 10),
    text: (email.text || email.snippet || '').slice(0, 3000),
    files: email.attachments?.length ? email.attachments.map((file) => file.filename) : undefined,
  }));
}

/**
 * One of the AI's helps on a conversation.
 *   summary  : what it is about and where it stands
 *   tasks    : what our side has to do (the person adds the ones they want as tasks)
 *   meeting  : a call, meeting or visit the mails ask for, with its time (to plan it)
 *   review   : a check of the mail that is about to be sent (needs \`draft\`)
 *   variants : the next mail in three versions (short, detailed, formal)
 * The last two are for the owner of the conversation: only they write in it.
 *
 * @param {{ kind: 'summary' | 'tasks' | 'meeting' | 'review' | 'variants', draft?: string,
 *           instruction?: string, mode?: 'reply' | 'follow_up' }} request  Validated
 * @param {Date} [now]  Only tests pass it
 */
export async function assistOnThread(actor, threadId, request, now = new Date()) {
  const thread = await loadThreadForViewer(actor, threadId);
  const base = {
    messages: await conversationOf(thread),
    subject: thread.subject,
    threadId: thread._id,
    userId: actor._id,
  };
  if (request.kind === 'summary') return (await summarizeThread(base)).output;
  if (request.kind === 'tasks') {
    const { output } = await extractEmailTasks({ ...base, today: todayInIndia(now) });
    return {
      tasks: output.tasks.map((task) => ({
        title: task.title,
        reason: task.reason,
        dueAt: task.dueInDays === null ? null : new Date(now.getTime() + task.dueInDays * DAY_MS),
      })),
      // What a task made from this conversation is about.
      opportunityId: thread.opportunityId ? String(thread.opportunityId) : null,
      accountId: thread.accountId ? String(thread.accountId) : null,
      contactId: thread.contactId ? String(thread.contactId) : null,
    };
  }
  if (request.kind === 'meeting') {
    const { output } = await suggestMeeting({ ...base, today: todayInIndia(now) });
    return {
      ...output,
      // India has one time zone and no summer time.
      startAt: output.startAt ? new Date(`${output.startAt}:00+05:30`) : null,
      opportunityId: thread.opportunityId ? String(thread.opportunityId) : null,
      accountId: thread.accountId ? String(thread.accountId) : null,
      contactId: thread.contactId ? String(thread.contactId) : null,
    };
  }

  if (request.kind === 'review') {
    if (!request.draft) throw badRequest('Write the mail first.');
    return (await reviewEmail({ ...base, draft: request.draft, sender: actor.name })).output;
  }
  const [contact, account] = await Promise.all([
    thread.contactId ? Contact.findById(thread.contactId).select('name designation').lean() : null,
    thread.accountId ? Account.findById(thread.accountId).select('name industry').lean() : null,
  ]);
  const { output } = await writeEmailVariants({
    ...base,
    mode: request.mode ?? 'reply',
    sender: actor.name,
    customer: {
      person: contact ? [contact.name, contact.designation].filter(Boolean).join(', ') : undefined,
      company: account?.name,
      industry: account?.industry,
    },
    instruction: request.instruction,
    draft: request.draft,
  });
  return output;
}

/**
 * What a file of a mail says. The file must sit on a mail of a conversation the person may
 * see. A PDF or a picture is read by a model that can see it; then it is summarized.
 * @param {{ url: string }} request  Validated: the file's own address (not its signed link)
 */
export async function summarizeMailFile(actor, { url }) {
  const key = keyFromUrl(url);
  const email = key ? await Email.findOne({ 'attachments.url': url }).lean() : null;
  const isVisible =
    email &&
    (await EmailThread.exists({ $and: [{ _id: email.threadId }, await visibleThreads(actor)] }));
  if (!isVisible) throw notFound('File not found');
  const file = email.attachments.find((item) => item.url === url);
  if ((file.size ?? 0) > MAX_READ_BYTES) {
    throw badRequest('This file is too large for the AI to read (the limit is 10 MB).');
  }
  const buffer = await readObject(key);
  if (!buffer) throw notFound('File not found');
  const read = await readChatFile(actor, {
    originalname: file.filename,
    mimetype: file.mimeType,
    buffer,
  });
  const { output } = await summarizeDocument({
    name: file.filename,
    text: read.text,
    threadId: email.threadId,
    userId: actor._id,
  });
  return { filename: file.filename, ...output };
}

/**
 * Tell people about mails of theirs that got no answer: once after 3 days and once after 7.
 * A background job calls this every morning. Safe to run twice (notify() refuses doubles).
 * @param {Date} [now]  Only tests pass it
 */
export async function runFollowUpReminders(now = new Date()) {
  let told = 0;
  for (const days of FOLLOW_UP_DAYS) {
    const threads = await EmailThread.find({
      lastDirection: 'outbound',
      contactId: { $ne: null },
      lastMessageAt: {
        $lte: new Date(now.getTime() - days * DAY_MS),
        $gt: new Date(now.getTime() - (days + 1) * DAY_MS),
      },
    })
      .limit(500)
      .lean();
    const contacts = await Contact.find({ _id: { $in: threads.map((thread) => thread.contactId) } })
      .select('name')
      .lean();
    const names = new Map(contacts.map((contact) => [String(contact._id), contact.name]));
    for (const thread of threads) {
      const who = names.get(String(thread.contactId)) ?? thread.participants[0] ?? 'the customer';
      const sent = await notify({
        // Who looks after the company or the lead (every mail is in the company mailbox).
        userId: await responsibleFor(thread, thread.userId),
        type: 'email_follow_up',
        title: `No answer from ${who} for ${days} days`,
        body: thread.subject || '(no subject)',
        link: `/inbox?thread=${thread._id}`,
        dedupeKey: `email-follow-up:${thread._id}:${+thread.lastMessageAt}:${days}`,
      });
      if (sent) told += 1;
    }
  }
  return { told };
}
