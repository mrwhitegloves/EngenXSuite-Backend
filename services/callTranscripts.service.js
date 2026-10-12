import { runAiTranscription } from '../ai/runChat.js';
import { isAiReady } from '../ai/settings.js';
import { isStorageConfigured, keyFromUrl, readObject } from '../infra/storage.js';
import { writeAudit } from '../lib/audit.js';
import { conflict, createAppError, notFound } from '../lib/errors.js';
import { CallTranscript } from '../models/callTranscript.model.js';
import { User } from '../models/user.model.js';
import { loadCallForAction } from './calls.service.js';

// The text of a recorded call. It is made only when a person asks for it (never by itself),
// from the recording in our storage, by an audio-to-text model. It is kept with the call, so
// everyone who may see the call (the caller, their manager, the CEO) reads the same text;
// any of them can have it made again.

async function toView(transcript) {
  if (!transcript) return null;
  const user = transcript.generatedBy
    ? await User.findById(transcript.generatedBy).select('name').lean()
    : null;
  return {
    text: transcript.text,
    model: transcript.model ?? null,
    seconds: transcript.seconds ?? null,
    generatedAt: transcript.generatedAt,
    generatedBy: user?.name ?? null,
  };
}

/** The saved text of a call, for someone who may see the call. */
export async function getTranscript(actor, callId) {
  const call = await loadCallForAction(actor, callId, 'view');
  return {
    isAiReady: isAiReady(),
    hasRecording: Boolean(call.recordingUrl),
    transcript: await toView(await CallTranscript.findOne({ callId: call._id }).lean()),
  };
}

/** The saved text of a call as plain data, or null. For the AI chat (access already checked). */
export async function transcriptTextOf(callId) {
  return (await CallTranscript.findOne({ callId }).select('text').lean())?.text ?? null;
}

/** Make (or make again) the text of a call from its recording. */
export async function makeTranscript(actor, callId, context = {}) {
  const call = await loadCallForAction(actor, callId, 'view');
  if (!call.recordingUrl) throw conflict('This call has no recording.');
  if (!isStorageConfigured()) {
    throw createAppError('STORAGE_NOT_CONFIGURED', 503, 'File storage is not set up yet.');
  }
  const audio = await readObject(keyFromUrl(call.recordingUrl));
  if (!audio) throw notFound('The recording of this call could not be found.');

  const result = await runAiTranscription({
    audio,
    format: 'mp3',
    userId: actor._id,
    entityType: 'calls',
    entityId: call._id,
  });
  if (!result.text) {
    throw conflict('No speech was heard in this recording, so there is no text to keep.');
  }
  const transcript = await CallTranscript.findOneAndUpdate(
    { callId: call._id },
    {
      $set: {
        text: result.text,
        model: result.model,
        seconds: result.seconds,
        aiRunId: result.runId,
        generatedAt: new Date(),
        generatedBy: actor._id,
      },
    },
    { upsert: true, returnDocument: 'after' },
  ).lean();
  await writeAudit({
    actor,
    action: 'call.transcript_made',
    entityType: 'calls',
    entityId: call._id,
    newValue: { model: result.model, seconds: result.seconds },
    requestId: context.requestId,
  });
  return { isAiReady: true, hasRecording: true, transcript: await toView(transcript) };
}
