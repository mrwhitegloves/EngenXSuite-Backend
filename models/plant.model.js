import mongoose from 'mongoose';

// A plant (factory site) of a customer company (Master Prompt Section 6). It always belongs to
// one account and holds only plant facts: nothing about the company is repeated here.
// The people of a plant are links to contacts, never typed names.
// Schema only: no methods (decision 0005).

export const DIGITAL_MATURITY = ['none', 'basic', 'intermediate', 'advanced'];
// The four "head of …" links of a plant. Used wherever those links must be checked or cleared.
export const PLANT_HEAD_FIELDS = [
  'plantHeadId',
  'maintenanceHeadId',
  'productionHeadId',
  'digitalHeadId',
];

const { ObjectId } = mongoose.Schema.Types;
const contactLink = { type: ObjectId, ref: 'Contact' };

const plantSchema = new mongoose.Schema(
  {
    accountId: { type: ObjectId, ref: 'Account', required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    location: {
      type: new mongoose.Schema(
        {
          addressLine: { type: String, trim: true },
          city: { type: String, trim: true },
          state: { type: String, trim: true },
          country: { type: String, trim: true },
          pincode: { type: String, trim: true },
        },
        { _id: false },
      ),
      default: undefined,
    },
    process: { type: String, trim: true },
    plantType: { type: String, trim: true },
    size: { type: String, trim: true },
    productionCapacity: { type: String, trim: true },

    plantHeadId: contactLink,
    maintenanceHeadId: contactLink,
    productionHeadId: contactLink,
    digitalHeadId: contactLink,
    itOtContactIds: { type: [contactLink], default: [] },

    existingAutomation: { type: String, trim: true },
    plcScada: { type: String, trim: true },
    mesErp: { type: String, trim: true },
    digitalMaturity: { type: String, enum: DIGITAL_MATURITY },

    createdBy: { type: ObjectId, ref: 'User' },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true, versionKey: false },
);

plantSchema.index({ accountId: 1 });
// So that deleting a contact can find and clear the plants that name it.
for (const field of PLANT_HEAD_FIELDS) plantSchema.index({ [field]: 1 }, { sparse: true });
plantSchema.index({ itOtContactIds: 1 });

export const Plant = mongoose.models.Plant ?? mongoose.model('Plant', plantSchema);
