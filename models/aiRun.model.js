import mongoose from 'mongoose';

// A record of every model call (Master Prompt Section 71): which task, which model, what came
// back, what it cost. Written only by runAiTask() in ai/runTask.js. Never changed afterwards.
// Schema only: no methods (decision 0005).

const { ObjectId } = mongoose.Schema.Types;

export const AI_RUN_STATUSES = [
  'success',
  'invalid_output', // the model answered, but not in the shape the task needs
  'failed', // the model could not be reached or refused
  'blocked_cap', // the monthly spending cap is used up
  'blocked_limit', // this person used all their runs for today
];

const aiRunSchema = new mongoose.Schema(
  {
    // The name of the task, for example "summarizeAccount".
    task: { type: String, required: true, maxlength: 60 },
    // The model that really answered (it can be a fallback). Empty when no call was made.
    model: { type: String, maxlength: 100 },
    // For example "summarizeAccount/v1".
    promptVersion: { type: String, required: true, maxlength: 80 },
    // The records the prompt was built from, as { kind: 'accounts', id }. References only:
    // their data is not copied here.
    inputRefs: {
      type: [{ _id: false, kind: { type: String }, id: { type: ObjectId } }],
      default: [],
    },
    // The validated answer; or the raw text when it was not valid.
    output: { type: mongoose.Schema.Types.Mixed },
    status: { type: String, enum: AI_RUN_STATUSES, required: true },
    error: { type: String, maxlength: 500 },
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    // From the provider's own cost figure, in millionths of a US dollar; and in paise.
    costMicroUsd: { type: Number, default: 0 },
    costPaise: { type: Number, default: 0 },
    latencyMs: { type: Number },
    // Who asked. Empty for runs the system starts by itself.
    userId: { type: ObjectId, ref: 'User' },
    // The record the run is about.
    entityType: { type: String, maxlength: 40 },
    entityId: { type: ObjectId },
    // Set on the second try after an answer that was not valid.
    retryOf: { type: ObjectId, ref: 'AiRun' },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false, collection: 'ai_runs' },
);

aiRunSchema.index({ task: 1, createdAt: -1 });
aiRunSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
aiRunSchema.index({ userId: 1, createdAt: -1 });
aiRunSchema.index({ status: 1 });
aiRunSchema.index({ createdAt: 1 });

export const AiRun = mongoose.models.AiRun ?? mongoose.model('AiRun', aiRunSchema);
