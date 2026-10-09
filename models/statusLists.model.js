import mongoose from 'mongoose';

// Status lists that an administrator manages in Settings, like tags: add, rename, reorder,
// switch off. Nothing about them is fixed in code (founder decision 0012).
//   account_statuses : where a company stands (Prospect, Customer, Dormant, …)
//   lead_statuses    : where a lead stands in day-to-day follow-up (New Lead, DNP, Follow-up, …)
// A lead also has a pipeline stage (models/pipelineStage.model.js); the two exist side by side.
// A record stores only the status's _id, so a rename shows everywhere at once.
// Schema only: no methods (decision 0005).

function statusListSchema() {
  const schema = new mongoose.Schema(
    {
      name: { type: String, required: true, trim: true, maxlength: 60 },
      // A fixed identifier for automation rules, imports and reports. Made from the first name
      // and never changed afterwards, even when the status is renamed.
      key: { type: String, required: true, unique: true },
      // Position in pickers and filters.
      order: { type: Number, required: true },
      // A design-token name, never a colour value.
      color: { type: String },
      // An inactive status is hidden from pickers but stays on the records that have it.
      isActive: { type: Boolean, required: true, default: true },
      // The status a new record gets when none is chosen. Exactly one per list.
      isDefault: { type: Boolean, required: true, default: false },
    },
    { timestamps: true, versionKey: false },
  );
  schema.index({ order: 1 });
  return schema;
}

export const AccountStatus =
  mongoose.models.AccountStatus ??
  mongoose.model('AccountStatus', statusListSchema(), 'account_statuses');

export const LeadStatus =
  mongoose.models.LeadStatus ?? mongoose.model('LeadStatus', statusListSchema(), 'lead_statuses');
