import mongoose from 'mongoose';

// A user's saved set of filters for one screen (Master Prompt Section 74), for example
// "My open leads this month" on the pipeline. It stores the address values of the list
// (filters, search, sort, date range), never data. Private to its user.
// Schema only: no methods (decision 0005).

const savedViewSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // Screen key, for example "users" or "pipeline".
    screen: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    // The address values: { status: "active", sort: "-createdAt", range: "this_month" }.
    query: { type: mongoose.Schema.Types.Mixed, required: true, default: {} },
  },
  { timestamps: true, versionKey: false, minimize: false },
);

// One name per screen per user. Also serves "all views of this user on this screen".
savedViewSchema.index({ userId: 1, screen: 1, name: 1 }, { unique: true });

export const SavedView =
  mongoose.models.SavedView ?? mongoose.model('SavedView', savedViewSchema, 'saved_views');
