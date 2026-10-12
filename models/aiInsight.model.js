import mongoose from 'mongoose';

// What the AI said about one record: the summary of a company, the assessment of a lead.
// The newest one per record, kind and audience is kept; the history is in `ai_runs`.
// Written only by services/insights.service.js. Schema only: no methods (decision 0005).

const { ObjectId } = mongoose.Schema.Types;

export const INSIGHT_KINDS = ['account_summary', 'lead_assessment'];

const aiInsightSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: INSIGHT_KINDS, required: true },
    entityType: { type: String, required: true, maxlength: 40 },
    entityId: { type: ObjectId, required: true },
    // Who may read it. "all": built from everything on the record. "user:<id>": built only from
    // what that person may see (a company whose leads are not all theirs), so only for them.
    audience: { type: String, required: true, default: 'all', maxlength: 60 },
    // The validated answer of the task.
    content: { type: mongoose.Schema.Types.Mixed, required: true },
    aiRunId: { type: ObjectId, ref: 'AiRun', required: true },
    model: { type: String, maxlength: 100 },
    generatedAt: { type: Date, required: true },
    generatedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true, versionKey: false, collection: 'ai_insights' },
);

aiInsightSchema.index({ entityType: 1, entityId: 1, kind: 1, audience: 1 }, { unique: true });

export const AiInsight = mongoose.models.AiInsight ?? mongoose.model('AiInsight', aiInsightSchema);
