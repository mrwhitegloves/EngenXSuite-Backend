import mongoose from 'mongoose';

// The parts of a plant: departments, and production lines (Master Prompt Section 7).
// Plant → Department → Production line → Machine. A line may sit under a department or
// directly under the plant; a department sits directly under the plant.
// Schema only: no methods (decision 0005).

export const UNIT_TYPES = ['department', 'line'];

const { ObjectId } = mongoose.Schema.Types;

const plantUnitSchema = new mongoose.Schema(
  {
    plantId: { type: ObjectId, ref: 'Plant', required: true },
    type: { type: String, required: true, enum: UNIT_TYPES },
    // For a line: the department it belongs to, if any. Always empty for a department.
    parentId: { type: ObjectId, ref: 'PlantUnit' },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true, versionKey: false },
);

plantUnitSchema.index({ plantId: 1, type: 1 });
plantUnitSchema.index({ parentId: 1 }, { sparse: true });

export const PlantUnit =
  mongoose.models.PlantUnit ?? mongoose.model('PlantUnit', plantUnitSchema, 'plant_units');
