import mongoose from 'mongoose';

// One recording of a meeting, made by the meeting recorder (Chrome extension) of one person.
// A meeting may have several (the tab was reloaded, a second session later); the transcript
// of the meeting is all of them in time order. The text is in meeting_transcript_segments.
// Written only by services/meetingTranscripts.service.js. Schema only: no methods (decision 0005).

const { ObjectId } = mongoose.Schema.Types;

// recording: pieces are coming in. processing: stopped, some pieces are still being read.
// ready: every piece is read (or could not be read).
export const RECORDING_STATUSES = ['recording', 'processing', 'ready'];
export const RECORDING_STOP_REASONS = ['stopped', 'tab_closed', 'idle'];

const meetingRecordingSchema = new mongoose.Schema(
  {
    meetingId: { type: ObjectId, ref: 'Meeting', required: true },
    recordedBy: { type: ObjectId, ref: 'User', required: true },
    deviceId: { type: ObjectId, ref: 'RecorderDevice' },
    // The Google Meet code (abc-defg-hij).
    meetCode: { type: String, maxlength: 20 },
    status: { type: String, enum: RECORDING_STATUSES, required: true, default: 'recording' },
    // When the person confirmed, on purpose, that this meeting is to be recorded.
    consentConfirmedAt: { type: Date, required: true },
    startedAt: { type: Date, required: true },
    lastSegmentAt: { type: Date },
    stoppedAt: { type: Date },
    // How it stopped: the person pressed Stop, the Meet tab was closed, or nothing came for long.
    stopReason: { type: String, enum: RECORDING_STOP_REASONS },
    readyAt: { type: Date },
  },
  { timestamps: true, versionKey: false, collection: 'meeting_recordings' },
);
meetingRecordingSchema.index({ meetingId: 1, startedAt: 1 });
meetingRecordingSchema.index({ status: 1, lastSegmentAt: 1 });
meetingRecordingSchema.index({ recordedBy: 1, startedAt: -1 });

export const MeetingRecording =
  mongoose.models.MeetingRecording ?? mongoose.model('MeetingRecording', meetingRecordingSchema);
