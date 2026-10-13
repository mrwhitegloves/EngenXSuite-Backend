import mongoose from 'mongoose';

// A bundle: a named list of people and companies to write to in one go (bulk mail, bulk
// WhatsApp). A member is a person of a company (a contact) or the company's own address.
// Written only by services/bundles.service.js. Schema only: no methods (decision 0005).

const { ObjectId } = mongoose.Schema.Types;

const bundleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    createdBy: { type: ObjectId, ref: 'User', required: true },
    // Kept in step by the service, so a list of bundles needs no counting.
    memberCount: { type: Number, required: true, default: 0 },
  },
  { timestamps: true, versionKey: false, collection: 'bundles' },
);
bundleSchema.index({ createdBy: 1, createdAt: -1 });

export const BUNDLE_MEMBER_KINDS = ['person', 'company'];

const bundleMemberSchema = new mongoose.Schema(
  {
    bundleId: { type: ObjectId, ref: 'Bundle', required: true },
    // person: a contact. company: the company's own general address.
    kind: { type: String, enum: BUNDLE_MEMBER_KINDS, required: true },
    // "c:<contactId>" or "a:<accountId>": the same person or company is in a bundle once.
    key: { type: String, required: true },
    contactId: { type: ObjectId, ref: 'Contact' },
    accountId: { type: ObjectId, ref: 'Account', required: true },
    addedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true, versionKey: false, collection: 'bundle_members' },
);
bundleMemberSchema.index({ bundleId: 1, key: 1 }, { unique: true });
bundleMemberSchema.index({ bundleId: 1, _id: 1 });

export const Bundle = mongoose.models.Bundle ?? mongoose.model('Bundle', bundleSchema);
export const BundleMember =
  mongoose.models.BundleMember ?? mongoose.model('BundleMember', bundleMemberSchema);
