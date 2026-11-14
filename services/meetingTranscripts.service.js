import { runAiTranscription } from '../ai/runChat.js';
import { DEVANAGARI, romanizeTranscript } from '../ai/tasks/romanizeTranscript.js';
import { TRANSCRIPT_SETTINGS } from '../config/meetingTranscripts.js';
import { JOB_NAMES } from '../constants/jobNames.js';
import { SOCKET_EVENTS } from '../constants/socketEvents.js';
import { logger } from '../infra/logger.js';
import { enqueue } from '../infra/queues.js';
import { emitToAll } from '../infra/realtime.js';
import {
  deleteObject,
  isStorageConfigured,
  keyFromUrl,
  readObject,
  toReadableUrl,
  uploadObject,
} from '../infra/storage.js';
import { writeAudit } from '../lib/audit.js';
import { badRequest, conflict, createAppError, forbidden, notFound } from '../lib/errors.js';
import { Meeting } from '../models/meeting.model.js';
import { MeetingRecording } from '../models/meetingRecording.model.js';
import { MeetingTranscriptSegment } from '../models/meetingTranscriptSegment.model.js';
import { User } from '../models/user.model.js';
import { recordSystemActivity } from './activities.service.js';
import { createMeeting, getMeeting, loadMeetingForAction } from './meetings.service.js';
import { notify } from './notifications.service.js';

// Meeting transcripts from the meeting recorder (Chrome extension; docs/MEETING_RECORDER.md).
//
//   - The extension records two tracks of a Google Meet call: "mic" (the person recording, our
//     side) and "tab" (everyone else, as the Meet tab plays them). It cuts them at pauses and
//     sends each piece as a small WAV file while the meeting goes on.
//   - Each piece is stored (private bucket, 60 days) and read by the audio-to-text model in a
//     background job; Hindi comes back in Roman letters. The CRM and the extension show the
//     text within seconds ("near live").
//   - A recording belongs to one meeting of the CRM, and so to its company and lead. Who may
//     record: everyone who may see the meeting (founder 2026-11-14: all users). Who may read
//     the transcript: exactly who may see the meeting (loadMeetingForAction).
//   - When a recording stops and every piece is read, the company and lead timeline gets one
//     entry and the person who recorded is told.

const S = TRANSCRIPT_SETTINGS;
const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const WAITING = ['pending', 'processing'];
// A run that cannot work by trying again: the piece fails at once.
const FINAL_AI_ERRORS = ['AI_NOT_CONFIGURED', 'AI_LIMIT_REACHED', 'AUDIO_TOO_LARGE'];
const MAX_LINES = 5000;
const HOUR_MS = 60 * 60 * 1000;

const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const announce = () => emitToAll(SOCKET_EVENTS.meetingTranscriptsChanged);
const linkOf = (meetingId) => `/calendar?meeting=${meetingId}`;

/** abc-defg-hij from a Meet address or a typed code; null when it is none. */
export function meetCodeOf(text) {
  const match = String(text ?? '')
    .toLowerCase()
    .match(/[a-z]{3}-[a-z]{4}-[a-z]{3}/);
  return match && MEET_CODE.test(match[0]) ? match[0] : null;
}

/**
 * Read the header of a WAV file: its length in milliseconds. Throws for anything else.
 * The extension sends 16 kHz, 16-bit, mono PCM with the standard 44-byte header.
 */
export function wavDurationMs(buffer) {
  const isWav =
    Buffer.isBuffer(buffer) &&
    buffer.length > 44 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WAVE' &&
    buffer.toString('ascii', 12, 16) === 'fmt ' &&
    buffer.readUInt16LE(20) === 1;
  const byteRate = isWav ? buffer.readUInt32LE(28) : 0;
  if (!isWav || byteRate <= 0) throw badRequest('A piece must be a WAV file (PCM).');
  return Math.round(((buffer.length - 44) / byteRate) * 1000);
}

// ── Echo ───────────────────────────────────────────────────────────────────────────────────
// Without headphones, the laptop's microphone also hears the loudspeaker: the customer's words
// come in twice, once on "tab" and once (quieter) on "mic". A "mic" piece that overlaps a
// "tab" piece in time and says mostly the same words is that echo, and is not shown.

const wordsOf = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1);

/** How many of the words of `a` are also in `b` (0 … 1). */
export function wordOverlap(a, b) {
  const words = wordsOf(a);
  if (words.length === 0) return 0;
  const other = new Set(wordsOf(b));
  return words.filter((word) => other.has(word)).length / words.length;
}

/**
 * Mark "mic" lines that are an echo of an overlapping "tab" line.
 * @param {{ track: string, startMs: number, endMs: number, text: string }[]} lines  In time order
 * @returns {boolean[]} true for an echo, in the same order
 */
export function findEchoes(lines, { minOverlap = 0.6, slackMs = 1500 } = {}) {
  return lines.map((line) => {
    if (line.track !== 'mic' || wordsOf(line.text).length < 3) return false;
    return lines.some(
      (other) =>
        other.track === 'tab' &&
        other.startMs < line.endMs + slackMs &&
        other.endMs > line.startMs - slackMs &&
        wordOverlap(line.text, other.text) >= minOverlap,
    );
  });
}

// ── The recorder (extension) side ──────────────────────────────────────────────────────────

async function recordingView(recording) {
  const user = await User.findById(recording.recordedBy).select('name').lean();
  return {
    id: String(recording._id),
    meetingId: String(recording.meetingId),
    status: recording.status,
    startedAt: recording.startedAt,
    stoppedAt: recording.stoppedAt ?? null,
    recordedBy: { id: String(recording.recordedBy), name: user?.name ?? 'Someone' },
  };
}

/** The recording of this meeting that is going on now, if any. */
function activeRecordingOf(meetingId, now = new Date()) {
  return MeetingRecording.findOne({
    meetingId,
    status: 'recording',
    $or: [
      { lastSegmentAt: { $gt: new Date(now - S.idleStopMs) } },
      { lastSegmentAt: null, startedAt: { $gt: new Date(now - S.idleStopMs) } },
    ],
  }).lean();
}

async function recorderMeetingView(actor, meeting) {
  const view = await getMeeting(actor, meeting._id);
  const active = await activeRecordingOf(meeting._id);
  return {
    id: view.id,
    title: view.title,
    startAt: view.startAt,
    endAt: view.endAt,
    status: view.status,
    account: view.account,
    lead: view.lead,
    activeRecording: active ? await recordingView(active) : null,
  };
}

/** Meetings the actor may see, of the ones given. */
async function visibleOf(actor, meetings) {
  const seen = [];
  for (const meeting of meetings) {
    try {
      seen.push(await loadMeetingForAction(actor, meeting._id, 'view'));
    } catch {
      // Not visible to this person: left out.
    }
  }
  return seen;
}

/**
 * Which CRM meeting a Google Meet call is: the one with this Meet code nearest to now, and
 * my meetings of today to choose from when there is none.
 * @param {{ code: string }} query  Validated
 */
export async function findMeetingForCode(actor, { code }, now = new Date()) {
  const meetCode = meetCodeOf(code);
  if (!meetCode) throw badRequest('This is not a Google Meet address.');
  const withCode = await visibleOf(
    actor,
    await Meeting.find({ meetLink: { $regex: meetCode }, status: { $ne: 'cancelled' } })
      .sort({ startAt: -1 })
      .limit(20)
      .lean(),
  );
  const distance = (meeting) => Math.abs(meeting.startAt - now);
  const matched = withCode.sort((a, b) => distance(a) - distance(b))[0] ?? null;

  // India day: from 00:00 to 24:00 India time.
  const indiaMidnight = new Date(
    Math.floor((now.getTime() + 5.5 * HOUR_MS) / (24 * HOUR_MS)) * 24 * HOUR_MS - 5.5 * HOUR_MS,
  );
  const today = await Meeting.find({
    $or: [{ organizerId: actor._id }, { internalAttendeeIds: actor._id }],
    status: { $ne: 'cancelled' },
    startAt: { $gte: indiaMidnight, $lt: new Date(indiaMidnight.getTime() + 24 * HOUR_MS) },
    ...(matched ? { _id: { $ne: matched._id } } : {}),
  })
    .sort({ startAt: 1 })
    .limit(20)
    .lean();
  return {
    meetCode,
    matched: matched ? await recorderMeetingView(actor, matched) : null,
    today: await Promise.all(today.map((meeting) => recorderMeetingView(actor, meeting))),
  };
}

/**
 * Start recording a Meet call: for a meeting of the CRM, or a new one about a company (and
 * lead) made now (it is NOT put into Google Calendar: the call is going on already). The same
 * person starting again on the same meeting (the tab was reloaded) goes on with their
 * recording; someone else recording it already is refused.
 * @param {{ meetCode: string, meetingId?: string, accountId?: string, opportunityId?: string,
 *           title?: string, consent: true }} data  Validated
 */
export async function startRecording(actor, data, context = {}) {
  if (!isStorageConfigured()) {
    throw createAppError('STORAGE_NOT_CONFIGURED', 503, 'File storage is not set up yet.');
  }
  const meetCode = meetCodeOf(data.meetCode);
  if (!meetCode) throw badRequest('This is not a Google Meet address.');
  let meeting;
  if (data.meetingId) {
    meeting = await loadMeetingForAction(actor, data.meetingId, 'view');
    if (meeting.status === 'cancelled') throw conflict('This meeting is cancelled.');
  } else {
    if (!data.accountId && !data.opportunityId) {
      throw badRequest('Choose the meeting, or the company the meeting is with.');
    }
    const startAt = new Date();
    const created = await createMeeting(
      actor,
      {
        title: data.title || 'Google Meet call',
        mode: 'online',
        startAt,
        endAt: new Date(startAt.getTime() + HOUR_MS),
        ...(data.opportunityId
          ? { opportunityId: data.opportunityId }
          : { accountId: data.accountId }),
      },
      { ...context, bookedVia: 'recorder', meetLink: `https://meet.google.com/${meetCode}` },
    );
    meeting = await Meeting.findById(created.id).lean();
  }

  const active = await activeRecordingOf(meeting._id);
  if (active && !sameId(active.recordedBy, actor._id)) {
    const by = await User.findById(active.recordedBy).select('name').lean();
    throw conflict(`${by?.name ?? 'A colleague'} is recording this meeting already.`);
  }
  const recording =
    active ??
    (
      await MeetingRecording.create({
        meetingId: meeting._id,
        recordedBy: actor._id,
        deviceId: context.deviceId,
        meetCode,
        consentConfirmedAt: new Date(),
        startedAt: new Date(),
      })
    ).toObject();
  if (!active) {
    await writeAudit({
      actor,
      action: 'meeting.recording_started',
      entityType: 'meetings',
      entityId: meeting._id,
      newValue: { recordingId: String(recording._id), meetCode, consent: true },
      requestId: context.requestId,
    });
  }
  announce();
  return {
    recording: await recordingView(recording),
    meeting: await recorderMeetingView(actor, meeting),
  };
}

async function loadOwnRecording(actor, recordingId) {
  const recording = await MeetingRecording.findById(recordingId).lean();
  if (!recording || !sameId(recording.recordedBy, actor._id)) {
    throw notFound('Recording not found');
  }
  return recording;
}

/** Queue the reading of a piece. Without the queue (Redis down) it runs here, in the background. */
async function queueSegment(segmentId) {
  try {
    await enqueue(
      'ai',
      JOB_NAMES.transcriptSegment,
      { segmentId: String(segmentId) },
      { jobId: `transcript-segment-${segmentId}` },
    );
  } catch {
    transcribeSegment(segmentId).catch((error) =>
      logger.warn({ err: error, segmentId: String(segmentId) }, 'Transcript piece not read yet'),
    );
  }
}

/**
 * One piece of speech from the extension. Sending the same piece again (same `clientKey`)
 * changes nothing. A recording stopped because nothing came for a while (the laptop slept)
 * goes on when pieces come again; one stopped by the person takes no more pieces.
 * @param {{ clientKey: string, track: 'mic' | 'tab', startedAt: number }} meta  Validated
 * @param {Buffer} audio  The WAV file
 */
export async function addSegment(actor, recordingId, meta, audio, now = new Date()) {
  const recording = await loadOwnRecording(actor, recordingId);
  const existing = await MeetingTranscriptSegment.findOne({
    recordingId: recording._id,
    clientKey: meta.clientKey,
  }).lean();
  if (existing) return { id: String(existing._id), status: existing.status, duplicate: true };

  if (recording.stopReason && recording.stopReason !== 'idle') {
    throw conflict('This recording is stopped. Start a new one.');
  }
  if (now - recording.startedAt > S.maxRecordingMs) {
    throw conflict('This recording is longer than 4 hours. Start a new one.');
  }
  if (audio.length > S.maxSegmentBytes) throw badRequest('This piece is too large.');
  const durationMs = wavDurationMs(audio);
  if (durationMs > S.maxSegmentMs + 5000) throw badRequest('This piece is too long.');
  // The laptop's clock: trusted when it is close to ours, otherwise our clock places the piece.
  const claimed = new Date(meta.startedAt);
  const startedAt =
    Math.abs(claimed - now) <= S.maxClockSkewMs ? claimed : new Date(now - durationMs);

  const url = await uploadObject({
    key: `meetings/${recording.meetingId}/audio/${recording._id}/${meta.clientKey}.wav`,
    body: audio,
    contentType: 'audio/wav',
  });
  let segment;
  try {
    segment = await MeetingTranscriptSegment.create({
      recordingId: recording._id,
      meetingId: recording.meetingId,
      clientKey: meta.clientKey,
      track: meta.track,
      startedAt,
      durationMs,
      audioUrl: url,
      audioBytes: audio.length,
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    // Sent twice at the same moment: the other request saved it.
    const twin = await MeetingTranscriptSegment.findOne({
      recordingId: recording._id,
      clientKey: meta.clientKey,
    }).lean();
    return { id: String(twin._id), status: twin.status, duplicate: true };
  }
  await MeetingRecording.updateOne(
    { _id: recording._id },
    {
      $set: { lastSegmentAt: now, status: 'recording' },
      $unset: { stoppedAt: 1, stopReason: 1, readyAt: 1 },
    },
  );
  await queueSegment(segment._id);
  return { id: String(segment._id), status: 'pending', duplicate: false };
}

/**
 * The person stopped (or the Meet tab was closed). The transcript is finished once every
 * piece is read.
 * @param {{ reason?: 'stopped' | 'tab_closed' }} data  Validated
 */
export async function stopRecording(actor, recordingId, { reason = 'stopped' } = {}, context = {}) {
  const recording = await loadOwnRecording(actor, recordingId);
  if (recording.status === 'recording') {
    await MeetingRecording.updateOne(
      { _id: recording._id, status: 'recording' },
      { $set: { status: 'processing', stoppedAt: new Date(), stopReason: reason } },
    );
    await writeAudit({
      actor,
      action: 'meeting.recording_stopped',
      entityType: 'meetings',
      entityId: recording.meetingId,
      newValue: { recordingId: String(recording._id), reason },
      requestId: context.requestId,
    });
  }
  await finishIfRead(recording._id);
  announce();
  return recordingView(await MeetingRecording.findById(recording._id).lean());
}

/** What the extension's side panel shows while recording: the newest lines of the meeting. */
export async function getRecorderTranscript(actor, recordingId) {
  const recording = await loadOwnRecording(actor, recordingId);
  const transcript = await buildTranscript(recording.meetingId);
  return {
    recording: await recordingView(await MeetingRecording.findById(recording._id).lean()),
    waiting: transcript.waiting,
    lines: transcript.lines.filter((line) => !line.isEcho).slice(-200),
  };
}

// ── Reading the pieces (background) ────────────────────────────────────────────────────────

/**
 * Read one piece with the audio-to-text model. Safe to run twice: a piece is claimed first,
 * and a piece that has its text is left alone.
 */
export async function transcribeSegment(segmentId, now = new Date()) {
  const segment = await MeetingTranscriptSegment.findOneAndUpdate(
    {
      _id: segmentId,
      attempts: { $lt: S.maxAttempts },
      $or: [
        { status: 'pending' },
        // A run that died half way (server restart) is taken over after a while.
        { status: 'processing', updatedAt: { $lt: new Date(now - S.pendingRetryMs) } },
      ],
    },
    { $set: { status: 'processing' }, $inc: { attempts: 1 } },
    { returnDocument: 'after' },
  ).lean();
  if (!segment) return { skipped: true };
  const recording = await MeetingRecording.findById(segment.recordingId).lean();

  let result;
  try {
    const audio = segment.audioUrl ? await readObject(keyFromUrl(segment.audioUrl)) : null;
    if (!audio) throw createAppError('AUDIO_MISSING', 404, 'The audio of this piece is gone.');
    result = await runAiTranscription({
      audio,
      format: 'wav',
      userId: recording?.recordedBy,
      entityType: 'meetings',
      entityId: segment.meetingId,
      task: 'transcribeMeeting',
      countPerPerson: false,
    });
  } catch (error) {
    const final =
      FINAL_AI_ERRORS.includes(error?.code) ||
      error?.code === 'AUDIO_MISSING' ||
      segment.attempts >= S.maxAttempts;
    await MeetingTranscriptSegment.updateOne(
      { _id: segment._id },
      {
        $set: {
          status: final ? 'failed' : 'pending',
          error: String(error?.message ?? 'Could not be read').slice(0, 300),
        },
      },
    );
    if (final) {
      await finishIfRead(segment.recordingId);
      announce();
      return { failed: true };
    }
    throw error;
  }

  let text = result.text.trim();
  if (DEVANAGARI.test(text)) {
    try {
      text = (await romanizeTranscript({ text, meetingId: segment.meetingId })).output.text || text;
    } catch (error) {
      // The text stays as the model wrote it; better than no text.
      logger.warn({ err: error, segmentId: String(segment._id) }, 'Transcript not romanized');
    }
  }
  await MeetingTranscriptSegment.updateOne(
    { _id: segment._id },
    {
      $set: { status: text ? 'done' : 'empty', text: text || undefined, model: result.model },
      $unset: { error: 1 },
    },
  );
  await finishIfRead(segment.recordingId);
  announce();
  return { done: true, empty: !text };
}

/**
 * A stopped recording whose pieces are all read is ready: one timeline entry on the company
 * and lead, and the person who recorded is told. Safe to run twice (claimed once).
 */
export async function finishIfRead(recordingId) {
  const waiting = await MeetingTranscriptSegment.countDocuments({
    recordingId,
    status: { $in: WAITING },
  });
  if (waiting > 0) return false;
  const recording = await MeetingRecording.findOneAndUpdate(
    { _id: recordingId, status: 'processing' },
    { $set: { status: 'ready', readyAt: new Date() } },
    { returnDocument: 'after' },
  ).lean();
  if (!recording) return false;
  const meeting = await Meeting.findById(recording.meetingId).lean();
  if (!meeting) return true;
  const said = await MeetingTranscriptSegment.find({ recordingId, status: 'done' })
    .sort({ startedAt: 1 })
    .select('text durationMs')
    .lean();
  const minutes = Math.max(1, Math.round((recording.stoppedAt - recording.startedAt) / 60000));
  if (meeting.accountId || meeting.opportunityId) {
    await recordSystemActivity({
      type: 'MEETING',
      subtype: 'meeting_transcript',
      title: `Transcript ready: ${meeting.title}`,
      content: `${minutes} min recorded, ${said.length} parts of speech. ${said
        .slice(0, 3)
        .map((piece) => piece.text)
        .join(' ')
        .slice(0, 300)}`,
      accountId: meeting.accountId,
      opportunityId: meeting.opportunityId,
      userId: recording.recordedBy,
      occurredAt: recording.startedAt,
      refCollection: 'meeting_recordings',
      refId: recording._id,
    });
  }
  await notify({
    userId: recording.recordedBy,
    type: 'meeting_transcript_ready',
    title: 'The transcript of your meeting is ready',
    body: meeting.title,
    link: linkOf(meeting._id),
    dedupeKey: `transcript-ready:${recording._id}`,
  });
  return true;
}

/**
 * Every few minutes: finish recordings that went quiet (the laptop slept, the browser was
 * closed), read pieces again that are still waiting, and finish what is read.
 */
export async function runTranscriptSweep(now = new Date()) {
  const quiet = new Date(now - S.idleStopMs);
  const idle = await MeetingRecording.find({
    status: 'recording',
    $or: [{ lastSegmentAt: { $lt: quiet } }, { lastSegmentAt: null, startedAt: { $lt: quiet } }],
  })
    .select('_id lastSegmentAt startedAt')
    .lean();
  for (const recording of idle) {
    await MeetingRecording.updateOne(
      { _id: recording._id, status: 'recording' },
      {
        $set: {
          status: 'processing',
          stopReason: 'idle',
          stoppedAt: recording.lastSegmentAt ?? recording.startedAt,
        },
      },
    );
  }

  const stale = new Date(now - S.pendingRetryMs);
  const waiting = await MeetingTranscriptSegment.find({
    status: { $in: WAITING },
    updatedAt: { $lt: stale },
  })
    .select('_id attempts')
    .limit(200)
    .lean();
  let requeued = 0;
  for (const segment of waiting) {
    if (segment.attempts >= S.maxAttempts) {
      await MeetingTranscriptSegment.updateOne(
        { _id: segment._id, status: { $in: WAITING } },
        { $set: { status: 'failed', error: 'Could not be read after several tries.' } },
      );
    } else {
      // Pieces left "processing" by a run that died go back to waiting first.
      await MeetingTranscriptSegment.updateOne(
        { _id: segment._id, status: 'processing' },
        { $set: { status: 'pending' } },
      );
      await queueSegment(segment._id);
      requeued += 1;
    }
  }

  const processing = await MeetingRecording.find({ status: 'processing' }).select('_id').lean();
  let finished = 0;
  for (const recording of processing) {
    if (await finishIfRead(recording._id)) finished += 1;
  }
  if (idle.length || finished) announce();
  return { stoppedIdle: idle.length, requeued, finished };
}

/** Once a day: remove the audio of pieces older than 60 days. The text stays. */
export async function runTranscriptAudioCleanup(now = new Date()) {
  const old = await MeetingTranscriptSegment.find({
    createdAt: { $lt: new Date(now - S.audioKeepMs) },
    audioUrl: { $type: 'string' },
    audioDeletedAt: null,
  })
    .select('_id audioUrl')
    .limit(2000)
    .lean();
  for (const segment of old) {
    const key = keyFromUrl(segment.audioUrl);
    if (key) await deleteObject(key);
    await MeetingTranscriptSegment.updateOne(
      { _id: segment._id },
      { $set: { audioDeletedAt: now }, $unset: { audioUrl: 1 } },
    );
  }
  return { removed: old.length };
}

// ── The CRM side ───────────────────────────────────────────────────────────────────────────

/** All recordings of a meeting as one transcript, in time order. */
async function buildTranscript(meetingId) {
  const [recordings, segments] = await Promise.all([
    MeetingRecording.find({ meetingId }).sort({ startedAt: 1 }).lean(),
    MeetingTranscriptSegment.find({ meetingId })
      .sort({ startedAt: 1, _id: 1 })
      .limit(MAX_LINES)
      .lean(),
  ]);
  const users = new Map(
    (
      await User.find({ _id: { $in: recordings.map((recording) => recording.recordedBy) } })
        .select('name')
        .lean()
    ).map((user) => [String(user._id), user.name]),
  );
  const recorderOf = new Map(
    recordings.map((recording) => [String(recording._id), String(recording.recordedBy)]),
  );
  const firstAt = segments[0]?.startedAt?.getTime() ?? 0;
  const shown = segments.filter((segment) => ['done', 'failed'].includes(segment.status));
  const timed = shown.map((segment) => ({
    track: segment.track,
    startMs: segment.startedAt.getTime(),
    endMs: segment.startedAt.getTime() + segment.durationMs,
    text: segment.text ?? '',
  }));
  const echoes = findEchoes(timed);
  const lines = shown.map((segment, index) => {
    const recorderId = recorderOf.get(String(segment.recordingId));
    return {
      id: String(segment._id),
      recordingId: String(segment.recordingId),
      speaker:
        segment.track === 'mic'
          ? { kind: 'mic', name: users.get(recorderId) ?? 'Our side', userId: recorderId }
          : { kind: 'tab', name: 'Others in the meeting', userId: null },
      startedAt: segment.startedAt,
      offsetMs: segment.startedAt.getTime() - firstAt,
      durationMs: segment.durationMs,
      text: segment.text ?? '',
      status: segment.status,
      isEdited: Boolean(segment.editedAt),
      hasAudio: Boolean(segment.audioUrl),
      isEcho: echoes[index],
    };
  });
  return {
    recordings,
    users,
    lines,
    waiting: segments.filter((segment) => WAITING.includes(segment.status)).length,
  };
}

const clock = (ms) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const two = (value) => String(value).padStart(2, '0');
  return `${two(Math.floor(seconds / 3600))}:${two(Math.floor(seconds / 60) % 60)}:${two(seconds % 60)}`;
};

async function mayEditTranscript(actor, meeting, recordingIds = []) {
  try {
    await loadMeetingForAction(actor, meeting._id, 'edit');
    return true;
  } catch {
    return recordingIds.length > 0
      ? (await MeetingRecording.countDocuments({
          _id: { $in: recordingIds },
          recordedBy: actor._id,
        })) > 0
      : false;
  }
}

/** The transcript of a meeting, for the meeting's page. Visible to who may see the meeting. */
export async function getMeetingTranscript(actor, meetingId) {
  const meeting = await loadMeetingForAction(actor, meetingId, 'view');
  const { recordings, users, lines, waiting } = await buildTranscript(meeting._id);
  const canEditMeeting = await mayEditTranscript(actor, meeting);
  const mine = new Set(
    recordings
      .filter((recording) => sameId(recording.recordedBy, actor._id))
      .map((recording) => String(recording._id)),
  );
  return {
    recordings: recordings.map((recording) => ({
      id: String(recording._id),
      status: recording.status,
      startedAt: recording.startedAt,
      stoppedAt: recording.stoppedAt ?? null,
      recordedBy: {
        id: String(recording.recordedBy),
        name: users.get(String(recording.recordedBy)) ?? 'Someone',
      },
    })),
    isRecording: recordings.some((recording) => recording.status === 'recording'),
    waiting,
    lines: lines.map((line) => ({
      ...line,
      canEdit: canEditMeeting || mine.has(line.recordingId),
    })),
  };
}

async function loadSegmentForAction(actor, meetingId, segmentId, action) {
  const meeting = await loadMeetingForAction(actor, meetingId, 'view');
  const segment = await MeetingTranscriptSegment.findOne({
    _id: segmentId,
    meetingId: meeting._id,
  }).lean();
  if (!segment) throw notFound('Part of the transcript not found');
  if (action === 'edit' && !(await mayEditTranscript(actor, meeting, [segment.recordingId]))) {
    throw forbidden('Only the person who recorded, or who may change the meeting, can correct it.');
  }
  return { meeting, segment };
}

/**
 * Correct the words of one part. The model's own text is kept the first time (originalText).
 * @param {{ text: string }} change  Validated
 */
export async function editTranscriptSegment(actor, meetingId, segmentId, { text }, context = {}) {
  const { segment } = await loadSegmentForAction(actor, meetingId, segmentId, 'edit');
  if (WAITING.includes(segment.status)) throw conflict('This part is still being read.');
  await MeetingTranscriptSegment.updateOne(
    { _id: segment._id },
    {
      $set: {
        text,
        status: 'done',
        editedBy: actor._id,
        editedAt: new Date(),
        ...(segment.originalText === undefined ? { originalText: segment.text ?? '' } : {}),
      },
    },
  );
  await writeAudit({
    actor,
    action: 'meeting.transcript_corrected',
    entityType: 'meetings',
    entityId: segment.meetingId,
    oldValue: { segmentId: String(segment._id), text: segment.text ?? '' },
    newValue: { text },
    requestId: context.requestId,
  });
  announce();
  return { id: String(segment._id), text, isEdited: true };
}

/** A link (one hour) to the audio of one part, to listen to it. */
export async function getSegmentAudioLink(actor, meetingId, segmentId) {
  const { segment } = await loadSegmentForAction(actor, meetingId, segmentId, 'view');
  if (!segment.audioUrl) throw notFound('The audio of this part was removed after 60 days.');
  return { link: await toReadableUrl(segment.audioUrl) };
}

/**
 * The transcript as plain text ("[00:12:05] Asha: …"), without echoes and empty parts.
 * Used for the download and for the AI summary.
 */
export async function transcriptAsText(meetingId) {
  const { lines } = await buildTranscript(meetingId);
  return lines
    .filter((line) => !line.isEcho && line.status === 'done' && line.text)
    .map((line) => `[${clock(line.offsetMs)}] ${line.speaker.name}: ${line.text}`)
    .join('\n');
}

/** The download of a transcript (TXT). Audited: it is the whole conversation. */
export async function downloadTranscript(actor, meetingId, context = {}) {
  const meeting = await loadMeetingForAction(actor, meetingId, 'view');
  const text = await transcriptAsText(meeting._id);
  if (!text) throw notFound('This meeting has no transcript yet.');
  await writeAudit({
    actor,
    action: 'meeting.transcript_downloaded',
    entityType: 'meetings',
    entityId: meeting._id,
    requestId: context.requestId,
  });
  const date = meeting.startAt.toISOString().slice(0, 10);
  const header = `${meeting.title}\n${date}\n\n`;
  const safeTitle = meeting.title.replace(/[^\w\- ]+/g, '').slice(0, 60) || 'meeting';
  return { filename: `${safeTitle} ${date} transcript.txt`, text: header + text };
}

/** When a meeting is deleted: its recordings, their text and their audio go with it. */
export async function deleteMeetingTranscripts(meetingId) {
  const segments = await MeetingTranscriptSegment.find({ meetingId, audioUrl: { $type: 'string' } })
    .select('audioUrl')
    .lean();
  for (const segment of segments) {
    const key = keyFromUrl(segment.audioUrl);
    if (key) {
      await deleteObject(key).catch((error) =>
        logger.warn({ err: error }, 'Meeting audio could not be removed'),
      );
    }
  }
  await MeetingTranscriptSegment.deleteMany({ meetingId });
  await MeetingRecording.deleteMany({ meetingId });
}
