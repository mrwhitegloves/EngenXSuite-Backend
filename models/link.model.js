import mongoose from 'mongoose';

// Links (founder, 2026-10-30): the team's useful web addresses with a name, a description,
// credentials as key/value pairs ("Email ID" = …) and a thumbnail picture.
// Credential values are sealed with lib/secretBox.js; only links.service opens them.
// The thumbnail is an S3 address (private bucket); answers carry a signed link.
// Schema only: no methods (decision 0005).

const credentialSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true, maxlength: 60 },
    valueSealed: { type: String, default: '' },
  },
  { _id: false },
);

const linkSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    url: { type: String, required: true, trim: true, maxlength: 2000 },
    description: { type: String, default: '', maxlength: 1000 },
    credentials: { type: [credentialSchema], default: [] },
    thumbnailUrl: { type: String, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, versionKey: false },
);
linkSchema.index({ name: 1 });

export const Link = mongoose.models.Link ?? mongoose.model('Link', linkSchema);
