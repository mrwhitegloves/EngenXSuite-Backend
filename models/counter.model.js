import mongoose from 'mongoose';

// One running number per series (account codes, lead codes, later proposal and invoice numbers).
// A number is handed out by adding 1 in a single database step (lib/sequence.js), so two
// requests at the same moment can never get the same one.
// Schema only: no methods (decision 0005).

const counterSchema = new mongoose.Schema(
  {
    // The series, for example "account" or "lead".
    key: { type: String, required: true, unique: true },
    // How many numbers of this series were handed out so far.
    seq: { type: Number, required: true, default: 0 },
  },
  { versionKey: false },
);

export const Counter = mongoose.models.Counter ?? mongoose.model('Counter', counterSchema);
