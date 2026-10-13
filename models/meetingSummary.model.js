import mongoose from 'mongoose';

// The AI's summary of one meeting, made from its notes on a person's request, with the tasks
// it proposes. A proposed task becomes a real task only when a person accepts it.
// Written only by services/meetingSummaries.service.js. Schema only: no methods (decision 0005).

const { ObjectId } = mongoose.Schema.Types;
const lines = { type: [String], default: [] };

export const PROPOSED_TASK_STATUSES = ['pending', 'accepted', 'rejected'];

const meetingSummarySchema = new mongoose.Schema(
  {
    meetingId: { type: ObjectId, ref: 'Meeting', required: true, unique: true },
    // What it was made from. (A voice note is turned into text in the notes first.)
    sourceType: { type: String, enum: ['transcript', 'notes', 'voice_note'], required: true },
    summary: { type: String, required: true, maxlength: 3000 },
    clientProblems: lines,
    machinesDiscussed: lines,
    technicalRequirements: lines,
    decisionMakers: lines,
    competitors: lines,
    commitments: lines,
    nextSteps: lines,
    risks: lines,
    missingInformation: lines,
    budget: { type: String, maxlength: 500 },
    proposedTasks: {
      type: [
        {
          _id: false,
          title: { type: String, required: true, maxlength: 200 },
          dueAt: { type: Date },
          status: { type: String, enum: PROPOSED_TASK_STATUSES, default: 'pending' },
          taskId: { type: ObjectId, ref: 'Task' },
        },
      ],
      default: [],
    },
    aiRunId: { type: ObjectId, ref: 'AiRun', required: true },
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true, versionKey: false, collection: 'meeting_summaries' },
);

export const MeetingSummary =
  mongoose.models.MeetingSummary ?? mongoose.model('MeetingSummary', meetingSummarySchema);
