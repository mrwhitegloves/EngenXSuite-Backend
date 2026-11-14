import {
  runTranscriptAudioCleanup,
  runTranscriptSweep,
  transcribeSegment,
} from '../services/meetingTranscripts.service.js';

/** Read one piece of a meeting recording. Safe to run twice: the piece is claimed first. */
export async function runTranscriptSegmentJob({ segmentId }) {
  return transcribeSegment(segmentId);
}

/** Every 2 minutes: finish quiet recordings, read waiting pieces again. */
export async function runTranscriptSweepJob() {
  return runTranscriptSweep();
}

/** Every night: remove meeting audio older than 60 days. The text stays. */
export async function runTranscriptAudioCleanupJob() {
  return runTranscriptAudioCleanup();
}
