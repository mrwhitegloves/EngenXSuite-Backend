import { randomBytes } from 'node:crypto';
import { runAiTranscription } from '../ai/runChat.js';
import { summarizeMeeting } from '../ai/tasks/summarizeMeeting.js';
import { SOCKET_EVENTS } from '../constants/socketEvents.js';
import { emitToAll } from '../infra/realtime.js';
import {
  isStorageConfigured,
  keyFromUrl,
  readObject,
  toReadableUrl,
  uploadObject,
} from '../infra/storage.js';
import { badRequest, conflict, createAppError, notFound } from '../lib/errors.js';
import { Account } from '../models/account.model.js';
import { Meeting } from '../models/meeting.model.js';
import { MeetingSummary } from '../models/meetingSummary.model.js';
import { Opportunity } from '../models/opportunity.model.js';
import { loadMeetingForAction } from './meetings.service.js';
import { createTask } from './tasks.service.js';

// What is kept about a meeting after it: files (pictures, documents, a voice note), the AI's
// summary of the notes, and the tasks it proposes. Reading follows the meeting's own access
// rule; changing is for the people who may change the meeting.
//   - a voice note becomes text only when a person asks, and the text joins the notes
//   - a summary is made only when a person asks
//   - a proposed task becomes a real task only when a person accepts it

const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;
export const MAX_MEETING_FILE_BYTES = 25 * MB;
const MAX_FILES = 20;
const MIN_NOTES = 20;
const AUDIO_FORMATS = { mp3: 'mp3', mpeg: 'mp3', wav: 'wav', m4a: 'm4a', mp4: 'm4a', ogg: 'ogg' };

const extensionOf = (name) => String(name).toLowerCase().split('.').pop();
const audioFormatOf = (file) =>
  AUDIO_FORMATS[extensionOf(file.filename)] ??
  (String(file.mimeType).startsWith('audio/')
    ? (AUDIO_FORMATS[String(file.mimeType).split('/')[1]] ?? 'mp3')
    : null);
const announce = () => emitToAll(SOCKET_EVENTS.meetingsChanged);

/** The files of a meeting as a screen gets them: with a link that opens for an hour. */
export const meetingFileViews = (files = []) =>
  Promise.all(
    files.map(async (file) => ({
      filename: file.filename,
      mimeType: file.mimeType ?? '',
      size: file.size ?? 0,
      url: file.url,
      link: await toReadableUrl(file.url),
      isAudio: Boolean(audioFormatOf(file)),
    })),
  );

/**
 * Put a file on a meeting: a picture, a document, or a voice note.
 * @param {{ originalname: string, mimetype: string, buffer: Buffer, size: number }} file
 */
export async function addMeetingFile(actor, meetingId, file) {
  const meeting = await loadMeetingForAction(actor, meetingId, 'edit');
  if (!isStorageConfigured()) {
    throw createAppError('STORAGE_NOT_CONFIGURED', 503, 'File storage is not set up yet.');
  }
  if ((meeting.files ?? []).length >= MAX_FILES) {
    throw badRequest(`A meeting takes up to ${MAX_FILES} files.`);
  }
  const filename = String(file.originalname).slice(0, 200);
  const safe = filename.replace(/[^\w.\- ]+/g, '_').slice(-120);
  const url = await uploadObject({
    key: `meetings/${meeting._id}/${randomBytes(6).toString('hex')}-${safe}`,
    body: file.buffer,
    contentType: file.mimetype || 'application/octet-stream',
  });
  const entry = {
    filename,
    mimeType: file.mimetype || 'application/octet-stream',
    size: file.size,
    url,
    uploadedBy: actor._id,
    uploadedAt: new Date(),
  };
  await Meeting.updateOne({ _id: meeting._id }, { $push: { files: entry } });
  announce();
  return (await meetingFileViews([entry]))[0];
}

/**
 * Turn a voice note of a meeting into text and add it to the notes. Only on a person's request.
 * @param {{ url: string }} request  Validated: the file's own address
 * @returns {Promise<{ text: string, notes: string }>}
 */
export async function transcribeMeetingFile(actor, meetingId, { url }) {
  const meeting = await loadMeetingForAction(actor, meetingId, 'edit');
  const file = (meeting.files ?? []).find((item) => item.url === url);
  const format = file && audioFormatOf(file);
  if (!file) throw notFound('File not found');
  if (!format) throw badRequest('Only an audio file can be turned into text.');
  const audio = await readObject(keyFromUrl(file.url));
  if (!audio) throw notFound('File not found');
  const result = await runAiTranscription({
    audio,
    format,
    userId: actor._id,
    entityType: 'meetings',
    entityId: meeting._id,
  });
  if (!result.text) throw badRequest('No speech was heard in this audio file.');
  const notes = [meeting.notes, `[Voice note: ${file.filename}]\n${result.text}`]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 20000);
  await Meeting.updateOne({ _id: meeting._id }, { $set: { notes } });
  announce();
  return { text: result.text, notes };
}

function toView(summary, canEdit) {
  if (!summary) return null;
  return {
    summary: summary.summary,
    clientProblems: summary.clientProblems,
    machinesDiscussed: summary.machinesDiscussed,
    technicalRequirements: summary.technicalRequirements,
    budget: summary.budget || null,
    decisionMakers: summary.decisionMakers,
    competitors: summary.competitors,
    commitments: summary.commitments,
    nextSteps: summary.nextSteps,
    risks: summary.risks,
    missingInformation: summary.missingInformation,
    proposedTasks: summary.proposedTasks.map((task, index) => ({
      index,
      title: task.title,
      dueAt: task.dueAt ?? null,
      status: task.status,
      taskId: task.taskId ? String(task.taskId) : null,
    })),
    madeAt: summary.updatedAt,
    permissions: { canEdit },
  };
}

/** What is kept about a meeting after it: its summary (null when none was made) and its files. */
export async function getMeetingRecord(actor, meetingId) {
  const meeting = await loadMeetingForAction(actor, meetingId, 'view');
  const summary = await MeetingSummary.findOne({ meetingId: meeting._id }).lean();
  let canEdit = true;
  await loadMeetingForAction(actor, meetingId, 'edit').catch(() => {
    canEdit = false;
  });
  return { summary: toView(summary, canEdit), files: await meetingFileViews(meeting.files) };
}

/**
 * Let the AI summarize a meeting from its notes. Making it again replaces the earlier summary;
 * tasks that were accepted already stay.
 */
export async function summarizeMeetingNow(actor, meetingId) {
  const meeting = await loadMeetingForAction(actor, meetingId, 'edit');
  const notes = (meeting.notes ?? '').trim();
  if (notes.length < MIN_NOTES) {
    throw badRequest(
      'Write the notes of the meeting first (or add a voice note and turn it into text).',
    );
  }
  const [account, lead] = await Promise.all([
    meeting.accountId ? Account.findById(meeting.accountId).select('name industry').lean() : null,
    meeting.opportunityId
      ? Opportunity.findById(meeting.opportunityId).select('name requirement').lean()
      : null,
  ]);
  const { output, runId } = await summarizeMeeting({
    meeting: {
      title: meeting.title,
      kind: meeting.mode,
      date: meeting.startAt.toISOString().slice(0, 10),
      agenda: meeting.agenda || undefined,
      company: account?.name,
      industry: account?.industry,
      lead: lead ? { about: lead.name, requirement: lead.requirement } : undefined,
      customerPeople: meeting.attendees.map((person) => person.name ?? person.email),
    },
    notes,
    meetingId: meeting._id,
    userId: actor._id,
  });
  const earlier = await MeetingSummary.findOne({ meetingId: meeting._id }).lean();
  const kept = (earlier?.proposedTasks ?? []).filter((task) => task.status === 'accepted');
  const keptTitles = new Set(kept.map((task) => task.title));
  const { proposedTasks, ...lists } = output;
  const saved = await MeetingSummary.findOneAndUpdate(
    { meetingId: meeting._id },
    {
      $set: {
        ...lists,
        sourceType: notes.includes('[Voice note:') ? 'voice_note' : 'notes',
        proposedTasks: [
          ...kept,
          ...proposedTasks
            .filter((task) => !keptTitles.has(task.title))
            .map((task) => ({
              title: task.title,
              dueAt:
                task.dueInDays === null
                  ? undefined
                  : new Date(meeting.startAt.getTime() + task.dueInDays * DAY_MS),
              status: 'pending',
            })),
        ],
        aiRunId: runId,
        createdBy: actor._id,
      },
    },
    { upsert: true, returnDocument: 'after' },
  ).lean();
  announce();
  return toView(saved, true);
}

/**
 * Accept a proposed task (it becomes a real task of the actor, about the meeting's lead or
 * company) or reject it. Decided once.
 * @param {{ index: number, decision: 'accept' | 'reject' }} request  Validated
 */
export async function decideProposedTask(actor, meetingId, { index, decision }, context = {}) {
  const meeting = await loadMeetingForAction(actor, meetingId, 'edit');
  const summary = await MeetingSummary.findOne({ meetingId: meeting._id }).lean();
  const proposed = summary?.proposedTasks[index];
  if (!proposed) throw notFound('Proposed task not found');
  if (proposed.status !== 'pending') throw conflict('This task was decided already.');
  const status = `proposedTasks.${index}.status`;
  // Claimed first, only while it is still pending: two presses can never make two tasks.
  const claimed = await MeetingSummary.findOneAndUpdate(
    { _id: summary._id, [status]: 'pending' },
    { $set: { [status]: decision === 'accept' ? 'accepted' : 'rejected' } },
    { returnDocument: 'after' },
  ).lean();
  if (!claimed) throw conflict('This task was decided already.');
  if (decision === 'reject') return toView(claimed, true);
  try {
    const task = await createTask(
      actor,
      {
        title: proposed.title,
        description: `From the meeting "${meeting.title}".`,
        type: 'follow_up',
        priority: 'medium',
        dueAt: proposed.dueAt ?? null,
        ...(meeting.opportunityId
          ? { opportunityId: String(meeting.opportunityId) }
          : meeting.accountId
            ? { accountId: String(meeting.accountId) }
            : {}),
      },
      context,
    );
    const saved = await MeetingSummary.findOneAndUpdate(
      { _id: summary._id },
      { $set: { [`proposedTasks.${index}.taskId`]: task.id } },
      { returnDocument: 'after' },
    ).lean();
    return toView(saved, true);
  } catch (error) {
    // The task was not made: the proposal can be decided again.
    await MeetingSummary.updateOne({ _id: summary._id }, { $set: { [status]: 'pending' } });
    throw error;
  }
}
