import mongoose from 'mongoose';

// What a person thought of one AI answer: useful, not useful, or "it should have said …".
// One per person and answer (a second opinion replaces the first). This is what later shows
// which task needs a better prompt, and gives examples of good answers.
// Written only by services/insights.service.js. Schema only: no methods (decision 0005).

const { ObjectId } = mongoose.Schema.Types;

export const FEEDBACK_VERDICTS = ['accepted', 'rejected', 'edited'];

const aiFeedbackSchema = new mongoose.Schema(
  {
    // The model call that produced the answer, and the task it belongs to (for counting).
    aiRunId: { type: ObjectId, ref: 'AiRun', required: true },
    task: { type: String, required: true, maxlength: 60 },
    userId: { type: ObjectId, ref: 'User', required: true },
    verdict: { type: String, enum: FEEDBACK_VERDICTS, required: true },
    // "edited": what it should have said. "rejected": what was wrong (optional).
    note: { type: String, trim: true, maxlength: 2000 },
    // Set when the person turned the suggested next step into a task.
    taskId: { type: ObjectId, ref: 'Task' },
  },
  { timestamps: true, versionKey: false, collection: 'ai_feedback' },
);

aiFeedbackSchema.index({ aiRunId: 1, userId: 1 }, { unique: true });
aiFeedbackSchema.index({ task: 1, createdAt: -1 });

export const AiFeedback =
  mongoose.models.AiFeedback ?? mongoose.model('AiFeedback', aiFeedbackSchema);
