import mongoose from 'mongoose';

// The sales stages a lead moves through (Master Prompt Section 10). They are data: an
// administrator can add, rename and reorder them. An opportunity stores only the stage's _id.
// Schema only: no methods (decision 0005).

export const STAGE_TYPES = ['open', 'won', 'lost'];

const pipelineStageSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true, maxlength: 60 },
    // A fixed identifier for automation rules and reports. Never changes, even when the name does.
    key: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // Column order on the pipeline board.
    order: { type: Number, required: true },
    type: { type: String, required: true, enum: STAGE_TYPES, default: 'open' },
    // Suggested chance of winning (0–100) when a lead enters the stage.
    defaultProbability: { type: Number, min: 0, max: 100 },
    // A design-token name, never a colour value.
    color: { type: String },
    // An inactive stage is hidden from pickers but stays on records that use it.
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true, versionKey: false },
);

pipelineStageSchema.index({ order: 1 });

export const PipelineStage =
  mongoose.models.PipelineStage ??
  mongoose.model('PipelineStage', pipelineStageSchema, 'pipeline_stages');
