import { z } from 'zod';
import { TRANSCRIPT_TRACKS } from '../config/meetingTranscripts.js';
import { objectId } from './common.js';

// The meeting recorder (Chrome extension) and meeting transcripts.

const meetCode = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/[a-z]{3}-[a-z]{4}-[a-z]{3}/, 'Not a Google Meet address')
  .max(200);

export const pairBody = z.object({
  code: z.string().trim().min(6).max(20),
  deviceName: z.string().trim().max(100).optional(),
});

export const deviceParams = z.object({ deviceId: objectId });

export const meetingForCodeQuery = z.object({ code: meetCode });

export const startRecordingBody = z
  .object({
    meetCode,
    meetingId: objectId.optional(),
    accountId: objectId.optional(),
    opportunityId: objectId.optional(),
    title: z.string().trim().max(200).optional(),
    // The person confirms that everyone in the meeting was told it is recorded.
    consent: z.literal(true, {
      message: 'Confirm that everyone was told the meeting is recorded',
    }),
  })
  .refine((body) => body.meetingId || body.accountId || body.opportunityId, {
    message: 'Choose the meeting, or the company the meeting is with',
  });

export const recordingParams = z.object({ recordingId: objectId });

// The audio itself is the request body (audio/wav); these come in the address.
export const segmentQuery = z.object({
  clientKey: z
    .string()
    .trim()
    .regex(/^[\w-]{1,100}$/, 'Not a valid piece name'),
  track: z.enum(TRANSCRIPT_TRACKS),
  // When the speech started, in milliseconds since 1970 (the laptop's clock).
  startedAt: z.coerce.number().int().positive(),
});

export const stopRecordingBody = z.object({
  reason: z.enum(['stopped', 'tab_closed']).optional(),
});

export const segmentParams = z.object({ id: objectId, segmentId: objectId });
export const editSegmentBody = z.object({ text: z.string().trim().max(20000) });

export const summaryBody = z.object({
  // What the AI reads: the transcript of the recorder, or the notes a person wrote.
  source: z.enum(['transcript', 'notes']).optional(),
});

export const externalAnalysisBody = z.object({
  label: z.string().trim().min(1, 'Say where it comes from').max(100),
  text: z.string().trim().min(20, 'Paste the analysis').max(30000),
});
export const analysisParams = z.object({ id: objectId, analysisId: objectId });
