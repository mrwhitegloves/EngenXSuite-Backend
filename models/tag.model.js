import mongoose from 'mongoose';

// Tags: free labels the team puts on companies, people and leads ("Key account", "Exhibition
// 2026"). A record stores only tag _ids, so a rename shows everywhere at once (Section 12).
// Schema only: no methods (decision 0005).

export const TAG_TARGETS = ['account', 'contact', 'opportunity'];
// Design-token names a tag may use; never a colour value.
export const TAG_COLORS = ['brand', 'success', 'warning', 'danger', 'info'];

const tagSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 40 },
    // The name in lowercase: makes "Hot" and "hot" the same tag.
    key: { type: String, required: true, unique: true },
    color: { type: String, enum: TAG_COLORS },
    // Which kinds of record the tag is offered on.
    appliesTo: { type: [{ type: String, enum: TAG_TARGETS }], default: TAG_TARGETS },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, versionKey: false },
);

export const Tag = mongoose.models.Tag ?? mongoose.model('Tag', tagSchema);
