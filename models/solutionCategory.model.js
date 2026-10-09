import mongoose from 'mongoose';

// What the company sells, as a managed list (Master Prompt Section 11). An opportunity stores
// only the category's _id. Schema only: no methods (decision 0005).

const solutionCategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true, maxlength: 80 },
    order: { type: Number },
    // An inactive category is hidden from pickers but stays on records that use it.
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true, versionKey: false },
);

export const SolutionCategory =
  mongoose.models.SolutionCategory ??
  mongoose.model('SolutionCategory', solutionCategorySchema, 'solution_categories');
