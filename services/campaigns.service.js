import { env } from '../config/env.js';
import { JOB_NAMES } from '../constants/jobNames.js';
import { SOCKET_EVENTS } from '../constants/socketEvents.js';
import { isWhatsAppConfigured } from '../integrations/meta/whatsapp.js';
import { logger } from '../infra/logger.js';
import { enqueue } from '../infra/queues.js';
import { emitToAll } from '../infra/realtime.js';
import { writeAudit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { runListQuery } from '../lib/queryBuilder.js';
import { scopeFilter } from '../lib/scopeFilter.js';
import { BundleMember } from '../models/bundle.model.js';
import { Campaign, CampaignRecipient, RECIPIENT_STATUSES } from '../models/campaign.model.js';
import { EmailThread } from '../models/email.model.js';
import { User } from '../models/user.model.js';
import { UserGoogleConnection } from '../models/userGoogleConnection.model.js';
import { loadRequestUser } from './auth.service.js';
import { createBundle, describeMembers, loadBundle } from './bundles.service.js';
import { sendEmail, writeWithAi } from './emails.service.js';
import { notify } from './notifications.service.js';
import { sendTemplateMessage } from './whatsapp.service.js';

// Bulk sending (docs/BULK.md): one mail or one WhatsApp template to everyone in a bundle.
//
// HOW IT RUNS. Starting a sending copies the bundle into a list of recipients. Then ONE person
// is handled at a time, with the chosen gap in between (a background job per step). Every
// person ends as sent, failed or skipped, with the reason in plain words. A step is safe to
// run twice: a recipient is claimed before anything is sent, so nobody gets a message twice.
//
// THE RULES FOR MAIL, for each person, looking at the sender's own conversations with them:
//   - the customer wrote last            → skipped (they wait for a real answer, not bulk mail)
//   - we wrote last, less than N days ago → skipped (too soon for a reminder)
//   - we wrote last, N days ago or more   → a REMINDER, written by the AI from that
//                                           conversation, sent inside the same conversation
//                                           (the newest one when there are several)
//   - no conversation yet                 → a first mail (written by the AI for this reader,
//                                           or the same fixed text for everyone)
// A mail the AI wrote goes out without a person reading it, so one with something left to
// fill in ("[price]") is never sent: that person fails, with the reason.
//
// A mail goes out from the Gmail of the person who made the sending. Only they can start it.

const FEATURE = 'campaigns';
const OWNERSHIP = { ownerField: 'createdBy' };
const DAY_MS = 24 * 60 * 60 * 1000;
// A recipient that stayed "sending" this long was cut off by a restart.
const STUCK_MS = 10 * 60 * 1000;
const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const announce = () => emitToAll(SOCKET_EVENTS.campaignsChanged);
const dayWords = (date) =>
  new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'Asia/Kolkata' }).format(date);

const visibleTo = (actor) => scopeFilter(actor, FEATURE, OWNERSHIP);

async function loadCampaign(actor, campaignId) {
  const campaign = await Campaign.findOne({ $and: [{ _id: campaignId }, visibleTo(actor)] }).lean();
  if (!campaign) throw notFound('Bulk sending not found');
  return campaign;
}

/** How many recipients are in each state. */
async function countsOf(campaignIds) {
  const rows = await CampaignRecipient.aggregate([
    { $match: { campaignId: { $in: campaignIds } } },
    { $group: { _id: { campaign: '$campaignId', status: '$status' }, count: { $sum: 1 } } },
  ]);
  const byCampaign = new Map();
  for (const row of rows) {
    const key = String(row._id.campaign);
    const counts = byCampaign.get(key) ?? Object.fromEntries(RECIPIENT_STATUSES.map((s) => [s, 0]));
    counts[row._id.status] = row.count;
    byCampaign.set(key, counts);
  }
  return (id) => {
    const counts =
      byCampaign.get(String(id)) ?? Object.fromEntries(RECIPIENT_STATUSES.map((s) => [s, 0]));
    const { pending, sending, sent, failed, skipped } = counts;
    return {
      total: pending + sending + sent + failed + skipped,
      pending: pending + sending,
      sent,
      failed,
      skipped,
    };
  };
}

function toView(campaign, counts, senders, actor) {
  return {
    id: String(campaign._id),
    name: campaign.name,
    channel: campaign.channel,
    status: campaign.status,
    pauseReason: campaign.pauseReason ?? null,
    gapSeconds: campaign.gapSeconds,
    bundleName: campaign.bundleName ?? null,
    writeMode: campaign.writeMode ?? null,
    brief: campaign.brief ?? null,
    subject: campaign.subject ?? null,
    body: campaign.body ?? null,
    minDaysBeforeReminder: campaign.minDaysBeforeReminder,
    attachments: campaign.attachments.map((file) => ({ filename: file.filename })),
    templateName: campaign.templateName ?? null,
    templateLanguage: campaign.templateLanguage ?? null,
    templateParams: campaign.templateParams,
    sender: senders.get(String(campaign.createdBy)) ?? null,
    counts: counts(campaign._id),
    createdAt: campaign.createdAt,
    startedAt: campaign.startedAt ?? null,
    finishedAt: campaign.finishedAt ?? null,
    // Only the person whose mailbox it goes out from can start it or let it go on.
    permissions: { canRun: sameId(campaign.createdBy, actor._id) },
  };
}

async function viewsOf(campaigns, actor) {
  const [counts, users] = await Promise.all([
    countsOf(campaigns.map((item) => item._id)),
    User.find({ _id: { $in: campaigns.map((item) => item.createdBy) } })
      .select('name')
      .lean(),
  ]);
  const senders = new Map(users.map((user) => [String(user._id), user.name]));
  return campaigns.map((campaign) => toView(campaign, counts, senders, actor));
}

/** @param {{ page: number, pageSize: number }} query  Validated */
export async function listCampaigns(actor, query) {
  const { rows, pagination } = await runListQuery(Campaign, {
    filter: visibleTo(actor),
    sort: { createdAt: -1, _id: -1 },
    page: query.page,
    pageSize: query.pageSize,
  });
  return { items: await viewsOf(rows, actor), pagination };
}

export async function getCampaign(actor, campaignId) {
  return (await viewsOf([await loadCampaign(actor, campaignId)], actor))[0];
}

/**
 * Who got what, when, and why not: the timeline of a sending. Handled ones newest first, then
 * the ones still waiting in their order.
 * @param {{ status?: string, page: number, pageSize: number }} query  Validated
 */
export async function listRecipients(actor, campaignId, query) {
  const campaign = await loadCampaign(actor, campaignId);
  const { rows, pagination } = await runListQuery(CampaignRecipient, {
    filter: { campaignId: campaign._id, ...(query.status ? { status: query.status } : {}) },
    sort: { processedAt: -1, order: 1 },
    page: query.page,
    pageSize: query.pageSize,
  });
  return {
    items: rows.map((row) => ({
      id: String(row._id),
      kind: row.kind,
      name: row.name ?? '',
      company: row.company ?? '',
      accountId: row.accountId ? String(row.accountId) : null,
      email: row.email ?? null,
      phone: row.phone ?? null,
      status: row.status === 'sending' ? 'pending' : row.status,
      action: row.action ?? null,
      reason: row.reason ?? null,
      subject: row.subject ?? null,
      body: row.body ?? null,
      threadId: row.threadId ? String(row.threadId) : null,
      processedAt: row.processedAt ?? null,
    })),
    pagination,
  };
}

/**
 * Make a sending from a bundle. It is a draft until it is started: nothing goes out yet.
 * @param {object} data  Validated (validation/campaigns.js createCampaignBody)
 */
export async function createCampaign(actor, data, context = {}) {
  const bundle = await loadBundle(actor, data.bundleId);
  const members = await describeMembers(
    await BundleMember.find({ bundleId: bundle._id }).sort({ _id: 1 }).lean(),
  );
  if (members.length === 0) throw badRequest('This bundle is empty. Add people to it first.');
  const isMail = data.channel === 'email';
  const campaign = await Campaign.create({
    name: data.name,
    channel: data.channel,
    createdBy: actor._id,
    gapSeconds: data.gapSeconds,
    bundleId: bundle._id,
    bundleName: bundle.name,
    ...(isMail
      ? {
          writeMode: data.writeMode,
          brief: data.brief,
          subject: data.subject,
          body: data.body,
          minDaysBeforeReminder: data.minDaysBeforeReminder,
          attachments: data.attachments ?? [],
        }
      : {
          templateName: data.templateName,
          templateLanguage: data.templateLanguage,
          templateParams: data.templateParams ?? [],
        }),
  });
  // Who cannot be written to at all is said right away, before anything is started.
  const address = (member) => (isMail ? member.email : member.phone);
  const seen = new Set();
  await CampaignRecipient.insertMany(
    members.map((member, order) => {
      let skip = null;
      if (member.isGone) skip = 'This person or company is no longer in the CRM.';
      else if (!address(member)) {
        skip = isMail ? 'No email address is saved.' : 'No phone number is saved.';
      } else if (seen.has(address(member))) {
        skip = `The same ${isMail ? 'address' : 'number'} is in the bundle twice; it is written to once.`;
      }
      if (address(member)) seen.add(address(member));
      return {
        campaignId: campaign._id,
        order,
        kind: member.kind,
        contactId: member.contactId ?? undefined,
        accountId: member.accountId,
        opportunityId: member.leadId ?? undefined,
        name: member.name,
        company: member.company?.name,
        email: member.email ?? undefined,
        phone: member.phone ?? undefined,
        ...(skip ? { status: 'skipped', reason: skip, processedAt: new Date() } : {}),
      };
    }),
  );
  await writeAudit({
    actor,
    action: 'campaign.created',
    entityType: 'campaigns',
    entityId: campaign._id,
    newValue: { name: campaign.name, channel: campaign.channel, recipients: members.length },
    requestId: context.requestId,
  });
  announce();
  return getCampaign(actor, campaign._id);
}

// ── Deciding and writing one mail ───────────────────────────────────────────────────────────

const fill = (text, recipient) =>
  String(text ?? '')
    .replaceAll('{{name}}', recipient.name ?? '')
    .replaceAll('{{company}}', recipient.company ?? '');

const UNATTENDED =
  'This mail is sent at once, without a person reading it first. So: never write square brackets or anything left to fill in; leave out what you do not know; state no price, no discount and no date.';

/**
 * What a bulk mail does for one person: skip (with the reason), remind inside their newest
 * conversation, or write a first mail. Nothing is sent here.
 * @returns {Promise<{ skip: string } | { action: 'reminder' | 'new', thread?: object }>}
 */
async function decideMail(campaign, recipient, now) {
  const thread = await EmailThread.findOne({
    userId: campaign.createdBy,
    participants: recipient.email,
  })
    .sort({ lastMessageAt: -1 })
    .lean();
  if (!thread) return { action: 'new' };
  if (thread.lastDirection === 'inbound') {
    return {
      skip: `They wrote to you last (on ${dayWords(thread.lastMessageAt)}) and are waiting for your answer. No bulk mail is sent on top of that: answer them yourself.`,
    };
  }
  const days = Math.floor((now - thread.lastMessageAt) / DAY_MS);
  if (days < campaign.minDaysBeforeReminder) {
    return {
      skip: `You wrote to them ${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`} and they have not answered yet. A reminder goes only after ${campaign.minDaysBeforeReminder} days.`,
    };
  }
  return { action: 'reminder', thread };
}

/** The subject and text for one person. */
async function writeMail(campaign, recipient, decision, sender) {
  if (decision.action === 'reminder') {
    // A reminder is always written from the conversation it continues.
    const draft = await writeWithAi(sender, {
      mode: 'follow_up',
      threadId: String(decision.thread._id),
      instruction: `Write a short, polite reminder: we wrote before and got no answer. ${campaign.brief ? `What this round of mails is about: ${campaign.brief}. ` : ''}${UNATTENDED}`,
    });
    return { subject: decision.thread.subject, body: draft.body };
  }
  if (campaign.writeMode === 'fixed') {
    return { subject: fill(campaign.subject, recipient), body: fill(campaign.body, recipient) };
  }
  const draft = await writeWithAi(sender, {
    mode: 'new',
    accountId: String(recipient.accountId),
    ...(recipient.contactId ? { contactId: String(recipient.contactId) } : {}),
    instruction: `${campaign.brief} ${campaign.subject ? `The subject should be close to: "${campaign.subject}". ` : ''}${UNATTENDED}`,
  });
  return draft;
}

/**
 * What the sending would do for its first people, with the mail the AI would write for one of
 * them: to look at before starting. Sends nothing.
 */
export async function previewCampaign(actor, campaignId, now = new Date()) {
  const campaign = await loadCampaign(actor, campaignId);
  if (campaign.channel !== 'email') throw badRequest('A preview exists for mail only.');
  if (!sameId(campaign.createdBy, actor._id)) {
    throw forbidden('Only the person who made this sending can preview it.');
  }
  const recipients = await CampaignRecipient.find({ campaignId: campaign._id, status: 'pending' })
    .sort({ order: 1 })
    .limit(5)
    .lean();
  const plan = [];
  let sample = null;
  for (const recipient of recipients) {
    const decision = await decideMail(campaign, recipient, now);
    plan.push({
      name: recipient.name,
      company: recipient.company,
      email: recipient.email,
      will: decision.skip ? 'skip' : decision.action,
      reason: decision.skip ?? null,
    });
    if (!sample && !decision.skip) {
      const mail = await writeMail(campaign, recipient, decision, actor);
      sample = { to: recipient.name, action: decision.action, ...mail };
    }
  }
  return { plan, sample };
}

// ── Running ─────────────────────────────────────────────────────────────────────────────────

/** Errors that concern everyone: the sending stops instead of failing person after person. */
const STOPS_EVERYTHING = {
  GOOGLE_NOT_CONNECTED:
    'Your Gmail is not connected. Connect it under “Mail and calendar”, then go on.',
  GOOGLE_ACCESS_REVOKED:
    'Google no longer allows access to your mailbox. Connect it again, then go on.',
  AI_LIMIT_REACHED: 'The AI limit is reached (Settings → AI). Go on when there is room again.',
  AI_NOT_CONFIGURED: 'The AI is not set up, so mails cannot be written.',
  WHATSAPP_NOT_CONFIGURED: 'WhatsApp is not set up yet.',
};

/** What went wrong, in words a person who is not a programmer understands. */
function plainReason(error) {
  const code = error?.code;
  const text = String(error?.message ?? '').slice(0, 250);
  if (code === 'NOT_FOUND') return 'You may not see this company any more, so nothing was sent.';
  if (code === 'GOOGLE_UNREACHABLE')
    return 'Gmail could not be reached at that moment. Try this person again.';
  if (code === 'GMAIL_ERROR') return `Gmail did not take the mail. ${text}`;
  if (code === 'WHATSAPP_UNREACHABLE')
    return 'WhatsApp could not be reached at that moment. Try this person again.';
  if (code === 'WHATSAPP_ERROR') return `WhatsApp did not take the message. ${text}`;
  if (code?.startsWith?.('AI_')) return `The AI could not write this mail. ${text}`;
  return text || 'It could not be sent, for a reason the system did not explain.';
}

async function handleRecipient(campaign, recipient, sender, now) {
  if (campaign.channel === 'whatsapp') {
    await sendTemplateMessage(
      sender,
      {
        phone: recipient.phone,
        templateName: campaign.templateName,
        language: campaign.templateLanguage,
        params: campaign.templateParams.map((text) => fill(text, recipient)),
      },
      now,
    );
    return { status: 'sent', action: 'template', body: `Template: ${campaign.templateName}` };
  }
  const decision = await decideMail(campaign, recipient, now);
  if (decision.skip) return { status: 'skipped', reason: decision.skip };
  const mail = await writeMail(campaign, recipient, decision, sender);
  const leftOpen = /\[[^\]\n]{1,60}\]/.exec(`${mail.subject} ${mail.body}`);
  if (leftOpen) {
    return {
      status: 'failed',
      action: decision.action,
      subject: mail.subject,
      body: mail.body,
      reason: `The AI left something to fill in (${leftOpen[0]}), so the mail was not sent. Write to this person yourself.`,
    };
  }
  const sent = await sendEmail(sender, {
    ...(decision.action === 'reminder'
      ? { threadId: String(decision.thread._id) }
      : { to: [recipient.email], subject: mail.subject }),
    text: mail.body,
    ...(campaign.attachments.length ? { attachments: campaign.attachments } : {}),
  });
  return {
    status: 'sent',
    action: decision.action,
    subject: mail.subject,
    body: mail.body,
    threadId: sent.threadId ?? decision.thread?._id,
  };
}

/** Queue the next step of a sending. Without a queue, the sweep job picks it up. */
async function scheduleNext(campaign, delayMs) {
  const nextStepAt = new Date(Date.now() + delayMs);
  await Campaign.updateOne({ _id: campaign._id }, { $set: { nextStepAt } });
  // The automated tests run the steps themselves.
  if (env.NODE_ENV === 'test') return;
  try {
    await enqueue(
      'messaging',
      JOB_NAMES.campaignStep,
      { campaignId: String(campaign._id) },
      { delayMs, jobId: `campaign-${campaign._id}-${+nextStepAt}` },
    );
  } catch (error) {
    logger.warn({ err: error }, 'A bulk sending step was not queued; the sweep will start it');
  }
}

async function finish(campaign) {
  const done = await Campaign.findOneAndUpdate(
    { _id: campaign._id, status: 'running' },
    { $set: { status: 'finished', finishedAt: new Date() }, $unset: { nextStepAt: '' } },
  ).lean();
  if (!done) return;
  const counts = (await countsOf([campaign._id]))(campaign._id);
  await notify({
    userId: campaign.createdBy,
    type: 'bulk_finished',
    title: `Bulk sending finished: ${campaign.name}`,
    body: `${counts.sent} sent, ${counts.failed} failed, ${counts.skipped} skipped`,
    link: `/bulk?send=${campaign._id}`,
    dedupeKey: `bulk-finished:${campaign._id}`,
  });
}

/**
 * One step of a running sending: handle the next person, then queue the step after it. The
 * background job calls this. Safe to run twice: the person is claimed first.
 * @param {Date} [now]  Only tests pass it
 * @returns {Promise<string>} What happened: sent, failed, skipped, finished, paused, idle
 */
export async function runCampaignStep(campaignId, now = new Date()) {
  const campaign = await Campaign.findOne({ _id: campaignId, status: 'running' }).lean();
  if (!campaign) return 'idle';
  const recipient = await CampaignRecipient.findOneAndUpdate(
    { campaignId: campaign._id, status: 'pending' },
    { $set: { status: 'sending', processedAt: now } },
    { sort: { order: 1 }, returnDocument: 'after' },
  ).lean();
  if (!recipient) {
    await finish(campaign);
    announce();
    return 'finished';
  }

  let result;
  try {
    const sender = await loadRequestUser(campaign.createdBy);
    if (!sender) {
      throw Object.assign(new Error('sender'), { code: 'SENDER_GONE' });
    }
    result = await handleRecipient(campaign, recipient, sender, now);
  } catch (error) {
    const stop =
      error?.code === 'SENDER_GONE'
        ? 'The person who made this sending is no longer an active user.'
        : STOPS_EVERYTHING[error?.code];
    if (stop) {
      // Not this person's fault: they go back in line, and the sending waits for a person.
      await CampaignRecipient.updateOne(
        { _id: recipient._id },
        { $set: { status: 'pending' }, $unset: { processedAt: '' } },
      );
      await Campaign.updateOne(
        { _id: campaign._id, status: 'running' },
        { $set: { status: 'paused', pauseReason: stop }, $unset: { nextStepAt: '' } },
      );
      await notify({
        userId: campaign.createdBy,
        type: 'bulk_finished',
        title: `Bulk sending stopped: ${campaign.name}`,
        body: stop,
        link: `/bulk?send=${campaign._id}`,
        dedupeKey: `bulk-paused:${campaign._id}:${+now}`,
      });
      announce();
      return 'paused';
    }
    logger.info({ reason: error?.message, campaignId: String(campaign._id) }, 'Bulk: one failed');
    result = { status: 'failed', reason: plainReason(error) };
  }
  await CampaignRecipient.updateOne(
    { _id: recipient._id },
    { $set: { ...result, processedAt: now } },
  );
  announce();
  // A skipped person costs no waiting: the next one follows at once.
  await scheduleNext(campaign, result.status === 'skipped' ? 1000 : campaign.gapSeconds * 1000);
  return result.status;
}

/**
 * Every minute: wake sendings whose next step is overdue (the queue was away, or the server
 * restarted), and close recipients that were cut off in the middle of being sent. Such a
 * person is NOT sent to again by itself: the message may have gone out.
 * @param {Date} [now]  Only tests pass it
 */
export async function sweepCampaigns(now = new Date()) {
  const cut = await CampaignRecipient.updateMany(
    { status: 'sending', processedAt: { $lt: new Date(now.getTime() - STUCK_MS) } },
    {
      $set: {
        status: 'failed',
        reason:
          'The server restarted while this one was being sent. Look into your sent mail before you send to this person again.',
      },
    },
  );
  const asleep = await Campaign.find({
    status: 'running',
    $or: [{ nextStepAt: null }, { nextStepAt: { $lt: new Date(now.getTime() - 60 * 1000) } }],
  })
    .select('_id')
    .limit(50)
    .lean();
  for (const campaign of asleep) {
    await enqueue(
      'messaging',
      JOB_NAMES.campaignStep,
      { campaignId: String(campaign._id) },
      { jobId: `campaign-${campaign._id}-wake-${Math.floor(now / 60000)}` },
    ).catch(() => runCampaignStep(campaign._id));
  }
  return { woken: asleep.length, cutOff: cut.modifiedCount };
}

async function assertCanSend(campaign) {
  if (campaign.channel === 'whatsapp') {
    if (!isWhatsAppConfigured())
      throw conflict('WhatsApp is not set up yet, so nothing can be sent.');
    return;
  }
  const isConnected = await UserGoogleConnection.exists({
    userId: campaign.createdBy,
    status: 'connected',
  });
  if (!isConnected) throw conflict('Connect your Gmail first (My profile → Mail and calendar).');
}

/**
 * Start a draft, or let a paused sending go on. Only its maker: it goes out in their name.
 */
export async function startCampaign(actor, campaignId, context = {}) {
  const campaign = await loadCampaign(actor, campaignId);
  if (!sameId(campaign.createdBy, actor._id)) {
    throw forbidden(
      'Only the person who made this sending can start it: it goes out in their name.',
    );
  }
  if (!['draft', 'paused'].includes(campaign.status)) {
    throw conflict('This sending is running already, or it is over.');
  }
  await assertCanSend(campaign);
  const started = await Campaign.findOneAndUpdate(
    { _id: campaign._id, status: campaign.status },
    {
      $set: { status: 'running', startedAt: campaign.startedAt ?? new Date() },
      $unset: { pauseReason: '' },
    },
    { returnDocument: 'after' },
  ).lean();
  if (!started) throw conflict('This sending is running already, or it is over.');
  await writeAudit({
    actor,
    action: campaign.status === 'draft' ? 'campaign.started' : 'campaign.resumed',
    entityType: 'campaigns',
    entityId: campaign._id,
    requestId: context.requestId,
  });
  await scheduleNext(started, 1000);
  announce();
  return getCampaign(actor, campaign._id);
}

/** Pause a running sending, or cancel one that is not over (the rest is then never sent). */
export async function stopCampaign(actor, campaignId, { action }, context = {}) {
  const campaign = await loadCampaign(actor, campaignId);
  const from = action === 'pause' ? ['running'] : ['draft', 'running', 'paused'];
  const changed = await Campaign.findOneAndUpdate(
    { _id: campaign._id, status: { $in: from } },
    {
      $set:
        action === 'pause'
          ? { status: 'paused', pauseReason: `Paused by ${actor.name}.` }
          : { status: 'cancelled', finishedAt: new Date() },
      $unset: { nextStepAt: '' },
    },
  ).lean();
  if (!changed) {
    throw conflict(
      action === 'pause' ? 'This sending is not running.' : 'This sending is over already.',
    );
  }
  await writeAudit({
    actor,
    action: action === 'pause' ? 'campaign.paused' : 'campaign.cancelled',
    entityType: 'campaigns',
    entityId: campaign._id,
    requestId: context.requestId,
  });
  announce();
  return getCampaign(actor, campaign._id);
}

/**
 * Keep the people who did NOT get the message (failed, skipped, or never reached) as a new
 * bundle, to write to them another time.
 * @param {{ name: string, statuses?: string[] }} data  Validated
 */
export async function bundleFromUnsent(actor, campaignId, data, context = {}) {
  const campaign = await loadCampaign(actor, campaignId);
  const statuses = data.statuses ?? ['failed', 'skipped', 'pending'];
  const recipients = await CampaignRecipient.find({
    campaignId: campaign._id,
    status: { $in: statuses.includes('pending') ? [...statuses, 'sending'] : statuses },
    accountId: { $ne: null },
  })
    .sort({ order: 1 })
    .lean();
  if (recipients.length === 0) throw badRequest('Nobody is left: everyone got the message.');
  return createBundle(
    actor,
    {
      name: data.name,
      members: recipients.map((recipient) => ({
        kind: recipient.kind,
        key: recipient.contactId ? `c:${recipient.contactId}` : `a:${recipient.accountId}`,
        contactId: recipient.contactId,
        accountId: recipient.accountId,
      })),
    },
    context,
  );
}
