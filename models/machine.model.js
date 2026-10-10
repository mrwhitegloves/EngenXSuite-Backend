import mongoose from 'mongoose';

// A machine, or a group of identical machines, in a plant (Master Prompt Section 7).
// "32 CNC machines" is ONE row with quantity 32, not 32 rows.
// Schema only: no methods (decision 0005).

export const MACHINE_CRITICALITY = ['low', 'medium', 'high'];
export const DATA_AVAILABILITY = ['none', 'partial', 'full'];

const { ObjectId } = mongoose.Schema.Types;

const machineSchema = new mongoose.Schema(
  {
    plantId: { type: ObjectId, ref: 'Plant', required: true },
    // The department or production line it stands in (added with plant units).
    unitId: { type: ObjectId },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    quantity: { type: Number, required: true, min: 1, default: 1 },
    machineType: { type: String, trim: true },
    manufacturer: { type: String, trim: true },
    model: { type: String, trim: true },
    controller: { type: String, trim: true },
    plc: { type: String, trim: true },
    protocol: { type: String, trim: true },
    // The age is worked out from this year; it is never stored.
    yearInstalled: { type: Number, min: 1900 },
    criticality: { type: String, enum: MACHINE_CRITICALITY },
    condition: { type: String, trim: true },
    dataAvailability: { type: String, enum: DATA_AVAILABILITY },
    existingSensors: { type: [String], default: [] },

    createdBy: { type: ObjectId, ref: 'User' },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true, versionKey: false },
);

machineSchema.index({ plantId: 1 });
machineSchema.index({ unitId: 1 }, { sparse: true });
machineSchema.index({ machineType: 1 });

export const Machine = mongoose.models.Machine ?? mongoose.model('Machine', machineSchema);
