import mongoose from 'mongoose';

// The counters behind the AI limits. Written only by ai/budget.js.
// Schema only: no methods (decision 0005).

// One document per month: what the AI cost, against the cap.
const aiUsageMonthlySchema = new mongoose.Schema(
  {
    // "2026-10", in India time.
    month: { type: String, required: true, unique: true },
    totalCostPaise: { type: Number, required: true, default: 0 },
    runs: { type: Number, required: true, default: 0 },
    // Per task: { summarizeAccount: { costPaise, runs } }.
    byTask: { type: mongoose.Schema.Types.Mixed, default: {} },
    // The cap that was in force at the last run of the month.
    capPaise: { type: Number },
    alert80SentAt: { type: Date },
    capReachedAt: { type: Date },
  },
  { timestamps: true, versionKey: false, collection: 'ai_usage_monthly' },
);

// One document per person and day: how many AI runs they started.
const aiUsageDailySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // "2026-10-12", in India time.
    day: { type: String, required: true },
    count: { type: Number, required: true, default: 0 },
  },
  { timestamps: true, versionKey: false, collection: 'ai_usage_daily' },
);
aiUsageDailySchema.index({ userId: 1, day: 1 }, { unique: true });
// Old days are of no use: removed after 90 days.
aiUsageDailySchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const AiUsageMonthly =
  mongoose.models.AiUsageMonthly ?? mongoose.model('AiUsageMonthly', aiUsageMonthlySchema);
export const AiUsageDaily =
  mongoose.models.AiUsageDaily ?? mongoose.model('AiUsageDaily', aiUsageDailySchema);
