import mongoose from 'mongoose';

// The text of one recorded call, made from its recording by an audio-to-text model. One per
// call: making it again replaces it. It is kept (founder decision 2026-10-12) so the caller,
// their manager and the CEO read the same text and the audio is paid for once.
// As sensitive as the recording: read only with the "calls" permission for that call.
// Written only by services/callTranscripts.service.js. Schema only: no methods (decision 0005).

const { ObjectId } = mongoose.Schema.Types;

const callTranscriptSchema = new mongoose.Schema(
  {
    callId: { type: ObjectId, ref: 'Call', required: true, unique: true },
    text: { type: String, required: true },
    // The audio-to-text model that wrote it, and how long the audio was.
    model: { type: String, maxlength: 100 },
    seconds: { type: Number },
    aiRunId: { type: ObjectId, ref: 'AiRun' },
    generatedAt: { type: Date, required: true },
    generatedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true, versionKey: false, collection: 'call_transcripts' },
);

export const CallTranscript =
  mongoose.models.CallTranscript ?? mongoose.model('CallTranscript', callTranscriptSchema);
