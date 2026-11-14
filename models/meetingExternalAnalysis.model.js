import mongoose from 'mongoose';

// An analysis of a meeting made outside the CRM (ChatGPT, a colleague's own write-up) and
// pasted here by a person, next to the CRM's own AI summary. Plain text, shown as pasted.
// Written only by services/meetingSummaries.service.js. Schema only: no methods (decision 0005).

const { ObjectId } = mongoose.Schema.Types;

const meetingExternalAnalysisSchema = new mongoose.Schema(
  {
    meetingId: { type: ObjectId, ref: 'Meeting', required: true },
    // Where it comes from, in the person's words ("ChatGPT").
    label: { type: String, required: true, trim: true, maxlength: 100 },
    text: { type: String, required: true, maxlength: 30000 },
    addedBy: { type: ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, versionKey: false, collection: 'meeting_external_analyses' },
);
meetingExternalAnalysisSchema.index({ meetingId: 1, createdAt: -1 });

export const MeetingExternalAnalysis =
  mongoose.models.MeetingExternalAnalysis ??
  mongoose.model('MeetingExternalAnalysis', meetingExternalAnalysisSchema);
