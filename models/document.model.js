import mongoose from 'mongoose';

// A file kept in the CRM for a company (an offer, a drawing, a brochure, a purchase order):
// the documents of the company vault (Master Prompt Section 35). The file itself is in the
// private bucket; this row keeps its address. Folders and versions join in phase 08.
// Written only by services/documents.service.js. Schema only: no methods (decision 0005).

const { ObjectId } = mongoose.Schema.Types;

const documentSchema = new mongoose.Schema(
  {
    // What people call it; starts as the file's name.
    name: { type: String, required: true, trim: true, maxlength: 200 },
    filename: { type: String, required: true, maxlength: 200 },
    mimeType: { type: String, maxlength: 120 },
    size: { type: Number, required: true },
    // The address in our private bucket (never sent to a browser as it is).
    url: { type: String, required: true },
    accountId: { type: ObjectId, ref: 'Account', required: true },
    opportunityId: { type: ObjectId, ref: 'Opportunity' },
    uploadedBy: { type: ObjectId, ref: 'User', required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'documents' },
);
documentSchema.index({ accountId: 1, deletedAt: 1, createdAt: -1 });
documentSchema.index({ opportunityId: 1 });
documentSchema.index({ url: 1 });

export const Document = mongoose.models.Document ?? mongoose.model('Document', documentSchema);
