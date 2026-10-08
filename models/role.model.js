import mongoose from 'mongoose';
import { ACTIONS, FEATURES, SCOPES } from '../constants/permissions.js';

// A role is a named set of permission grants. Grants are embedded because they belong to exactly
// one role and are always read together with it. Schema only: no methods (decision 0005).

const grantSchema = new mongoose.Schema(
  {
    feature: { type: String, required: true, enum: FEATURES },
    action: { type: String, required: true, enum: ACTIONS },
    scope: { type: String, required: true, enum: SCOPES },
  },
  { _id: false },
);

const roleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true, maxlength: 60 },
    description: { type: String, trim: true, maxlength: 300 },
    // Seeded roles cannot be deleted (their grants can still be edited by the CEO).
    isSystem: { type: Boolean, required: true, default: false },
    grants: { type: [grantSchema], default: [] },
  },
  { timestamps: true },
);

export const Role = mongoose.models.Role ?? mongoose.model('Role', roleSchema);
