import mongoose from 'mongoose';
import { GENERATED_KIND_KEYS } from '../constants/generatedDocuments.js';

// A document made with the Document generator (founder, 2026-11-12): a proposal, a letter head
// or an invoice. `templateKey` names the client template it was made from; `data` holds the
// values typed into it (client name, sections, fee …). `ownerId` is the person who made it:
// the scope of the kind's feature (own / team / all) is checked against it.
// Schema only: no methods (decision 0005).

const generatedDocumentSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: GENERATED_KIND_KEYS, required: true },
    templateKey: { type: String, required: true, trim: true, maxlength: 60 },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    // The document's own reference, e.g. "ENGENX-SPB-DMA-2026-001" (typed, shown in the list).
    refNo: { type: String, default: '', trim: true, maxlength: 80 },
    // The client or addressee, for the list and search.
    clientName: { type: String, default: '', trim: true, maxlength: 200 },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, versionKey: false, collection: 'generated_documents', minimize: false },
);
generatedDocumentSchema.index({ kind: 1, updatedAt: -1 });
generatedDocumentSchema.index({ kind: 1, ownerId: 1 });

export const GeneratedDocument =
  mongoose.models.GeneratedDocument ?? mongoose.model('GeneratedDocument', generatedDocumentSchema);
