import mongoose from 'mongoose';

// The documents of the company: ONE library for the whole CRM (Master Prompt Section 35), kept
// in folders the team makes itself. A document is not tied to a customer: any of them can be
// sent to any customer. The file itself is in the private bucket; a row keeps its address.
// Written only by services/documents.service.js. Schema only: no methods (decision 0005).

const { ObjectId } = mongoose.Schema.Types;

const documentFolderSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    // The folder it is in; empty: at the top.
    parentId: { type: ObjectId, ref: 'DocumentFolder', default: null },
    createdBy: { type: ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, versionKey: false, collection: 'document_folders' },
);
// Two folders of one name cannot be next to each other.
documentFolderSchema.index({ parentId: 1, name: 1 }, { unique: true });

const documentSchema = new mongoose.Schema(
  {
    // What people call it; starts as the file's name.
    name: { type: String, required: true, trim: true, maxlength: 200 },
    filename: { type: String, required: true, maxlength: 200 },
    mimeType: { type: String, maxlength: 120 },
    size: { type: Number, required: true },
    // The address in our private bucket (never sent to a browser as it is).
    url: { type: String, required: true },
    // The folder it is in; empty: at the top.
    folderId: { type: ObjectId, ref: 'DocumentFolder', default: null },
    uploadedBy: { type: ObjectId, ref: 'User', required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'documents' },
);
documentSchema.index({ folderId: 1, deletedAt: 1, name: 1 });
documentSchema.index({ url: 1 });

export const DocumentFolder =
  mongoose.models.DocumentFolder ?? mongoose.model('DocumentFolder', documentFolderSchema);
export const Document = mongoose.models.Document ?? mongoose.model('Document', documentSchema);
