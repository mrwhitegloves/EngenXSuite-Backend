import mongoose from 'mongoose';

// A person at a customer company (Master Prompt Section 8). The ONE place a person's name,
// phone and email are stored; calls, WhatsApp messages and emails are matched to a contact by
// these. A contact always belongs to one account.
// Schema only: no methods (decision 0005).

export const STAKEHOLDER_ROLES = [
  'cxo',
  'plant_head',
  'digital_head',
  'maintenance_head',
  'production_head',
  'quality_head',
  'purchase',
  'it_ot',
  'other',
];
export const CONTACT_SOURCES = ['manual', 'meta_ads', 'website', 'email', 'import'];

const { ObjectId } = mongoose.Schema.Types;
const oneToFive = { type: Number, min: 1, max: 5 };

const contactSchema = new mongoose.Schema(
  {
    accountId: { type: ObjectId, ref: 'Account', required: true },
    plantId: { type: ObjectId },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    designation: { type: String, trim: true },
    department: { type: String, trim: true },
    // The database names of phone and email fields are fixed (decision 0013, lib/fieldNames.js).
    // Phone numbers are in the international form (lib/phone.js).
    phone_number: { type: String, trim: true },
    alt_phone_number: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    linkedinUrl: { type: String, trim: true },

    stakeholderRole: { type: String, enum: STAKEHOLDER_ROLES },
    decisionPower: oneToFive,
    technicalInfluence: oneToFive,
    commercialInfluence: oneToFive,
    relationshipStrength: oneToFive,

    ownerId: { type: ObjectId, ref: 'User' },
    tagIds: { type: [{ type: ObjectId, ref: 'Tag' }], default: [] },

    // What this person allowed. Nothing is assumed: both start as "not allowed to message".
    consent: {
      whatsappOptIn: { type: Boolean, required: true, default: false },
      whatsappOptInAt: { type: Date },
      whatsappOptOutAt: { type: Date },
      emailUnsubscribedAt: { type: Date },
      doNotCall: { type: Boolean, required: true, default: false },
    },

    // A saved copy of "when did we last talk"; only the activity service writes it.
    lastInteractionAt: { type: Date },
    source: { type: String, enum: CONTACT_SOURCES, default: 'manual' },
    importId: { type: ObjectId },
    createdBy: { type: ObjectId, ref: 'User' },
    // The user who filled in the form that created this contact by hand (decision 0013).
    formFilledBy: { type: ObjectId, ref: 'User' },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true, versionKey: false },
);

contactSchema.index({ accountId: 1 });
contactSchema.index({ phone_number: 1 }, { sparse: true });
contactSchema.index({ alt_phone_number: 1 }, { sparse: true });
contactSchema.index({ email: 1 }, { sparse: true });
contactSchema.index({ ownerId: 1 });
contactSchema.index({ stakeholderRole: 1 });

export const Contact = mongoose.models.Contact ?? mongoose.model('Contact', contactSchema);
