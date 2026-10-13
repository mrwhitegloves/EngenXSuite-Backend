import mongoose from 'mongoose';

// An address or a number that must not get bulk messages: the customer asked for that (through
// the link in a bulk mail, by writing STOP on WhatsApp, or by telling one of us).
// Kept by the address itself, not by the contact: it also holds when the person is saved a
// second time, or is only the general address of a company.
// Written only by services/bulkOptOuts.service.js. Schema only: no methods (decision 0005).

export const OPT_OUT_CHANNELS = ['email', 'whatsapp'];
// person: one of us put it in. link: the customer used the link in a bulk mail.
// message: the customer wrote STOP on WhatsApp.
export const OPT_OUT_SOURCES = ['person', 'link', 'message'];

const bulkOptOutSchema = new mongoose.Schema(
  {
    channel: { type: String, enum: OPT_OUT_CHANNELS, required: true },
    // An email address in small letters, or a phone number in the international form.
    address: { type: String, required: true, trim: true, maxlength: 320 },
    source: { type: String, enum: OPT_OUT_SOURCES, required: true },
    note: { type: String, trim: true, maxlength: 300 },
    // The user who put it in (source "person").
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, versionKey: false, collection: 'bulk_opt_outs' },
);
bulkOptOutSchema.index({ channel: 1, address: 1 }, { unique: true });
bulkOptOutSchema.index({ createdAt: -1 });

export const BulkOptOut =
  mongoose.models.BulkOptOut ?? mongoose.model('BulkOptOut', bulkOptOutSchema);
