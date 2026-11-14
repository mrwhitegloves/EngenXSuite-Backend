import mongoose from 'mongoose';

// One piece of speech of a meeting recording (cut by the extension at a pause, at most a
// minute) and its text. "mic": the person who recorded (our side). "tab": everyone else in
// the meeting, as heard from the Meet tab. The same piece uploaded twice is one row
// (`clientKey`). The audio is kept 60 days; the text stays.
// Written only by services/meetingTranscripts.service.js. Schema only: no methods (decision 0005).

const { ObjectId } = mongoose.Schema.Types;

// pending: waiting to be read. processing: being read now. done: has text.
// empty: nothing was said. failed: could not be read.
export const SEGMENT_STATUSES = ['pending', 'processing', 'done', 'empty', 'failed'];

const segmentSchema = new mongoose.Schema(
  {
    recordingId: { type: ObjectId, ref: 'MeetingRecording', required: true },
    meetingId: { type: ObjectId, ref: 'Meeting', required: true },
    // Given by the extension; the same piece sent again is recognised by it.
    clientKey: { type: String, required: true, maxlength: 100 },
    track: { type: String, enum: ['mic', 'tab'], required: true },
    // When the speech started and how long it was.
    startedAt: { type: Date, required: true },
    durationMs: { type: Number, required: true, min: 0 },
    // The WAV file in our private storage; removed after 60 days (audioDeletedAt).
    audioUrl: { type: String },
    audioBytes: { type: Number },
    audioDeletedAt: { type: Date },
    status: { type: String, enum: SEGMENT_STATUSES, required: true, default: 'pending' },
    attempts: { type: Number, default: 0 },
    // What was said, in Roman letters (Hindi is written as it sounds, never translated).
    text: { type: String, maxlength: 20000 },
    // The text as the model first wrote it, when a person corrected it.
    originalText: { type: String, maxlength: 20000 },
    editedBy: { type: ObjectId, ref: 'User' },
    editedAt: { type: Date },
    model: { type: String, maxlength: 100 },
    error: { type: String, maxlength: 300 },
  },
  { timestamps: true, versionKey: false, collection: 'meeting_transcript_segments' },
);
segmentSchema.index({ recordingId: 1, clientKey: 1 }, { unique: true });
segmentSchema.index({ meetingId: 1, startedAt: 1 });
segmentSchema.index({ status: 1, updatedAt: 1 });
segmentSchema.index({ audioDeletedAt: 1, createdAt: 1 });

export const MeetingTranscriptSegment =
  mongoose.models.MeetingTranscriptSegment ??
  mongoose.model('MeetingTranscriptSegment', segmentSchema);
