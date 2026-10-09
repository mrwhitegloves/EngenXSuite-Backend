import mongoose from 'mongoose';

// A customer company (Master Prompt Section 5): the centre of the data model. Plants, contacts,
// leads and documents all point to an account by its _id and never copy its details.
// "Account" here always means a company; people who sign in are "users".
// Schema only: no methods (decision 0005).

export const ACCOUNT_STATUSES = ['prospect', 'active', 'customer', 'dormant', 'lost', 'strategic'];
export const COMPANY_SIZES = ['1-50', '51-200', '201-1000', '1001-5000', '5000+'];
export const ACCOUNT_SOURCES = ['manual', 'meta_ads', 'website', 'email', 'import'];
export const ACCOUNT_POTENTIALS = ['low', 'medium', 'high'];
export const RELATIONSHIP_HEALTH = ['good', 'neutral', 'at_risk'];

const { ObjectId } = mongoose.Schema.Types;

const addressSchema = new mongoose.Schema(
  {
    addressLine: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    country: { type: String, trim: true },
    pincode: { type: String, trim: true },
  },
  { _id: false },
);

const accountSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    // The name in a comparable form (see lib/nameKey.js): finds the same company typed differently.
    nameKey: { type: String, required: true },
    industry: { type: String, trim: true },
    companyType: { type: String, trim: true },
    website: { type: String, trim: true },
    hq: { type: addressSchema, default: undefined },
    region: { type: String, trim: true },
    companySize: { type: String, enum: COMPANY_SIZES },
    // Money is stored as whole paise.
    annualRevenuePaise: { type: Number, min: 0 },
    // Sensitive: shown in full only to someone who may edit the account, masked elsewhere.
    gstin: { type: String, trim: true, uppercase: true },
    pan: { type: String, trim: true, uppercase: true },
    billingAddress: { type: addressSchema, default: undefined },

    // Who is responsible, and who else works on it. These two fields decide who may see it.
    ownerId: { type: ObjectId, ref: 'User', required: true },
    assignedUserIds: { type: [{ type: ObjectId, ref: 'User' }], default: [] },

    status: { type: String, required: true, enum: ACCOUNT_STATUSES, default: 'prospect' },
    tagIds: { type: [{ type: ObjectId, ref: 'Tag' }], default: [] },

    industrial: {
      type: new mongoose.Schema(
        {
          manufacturingProcess: { type: String, trim: true },
          plantType: { type: String, trim: true },
          approxPlantSize: { type: String, trim: true },
          automationLevel: { type: String, trim: true },
          digitalMaturity: { type: String, trim: true },
          existingPlc: { type: String, trim: true },
          existingScada: { type: String, trim: true },
          existingMes: { type: String, trim: true },
          existingErp: { type: String, trim: true },
          existingIot: { type: String, trim: true },
          existingVendors: { type: [String], default: undefined },
          systemIntegrators: { type: [String], default: undefined },
        },
        { _id: false },
      ),
      default: undefined,
    },
    commercial: {
      type: new mongoose.Schema(
        {
          accountPotential: { type: String, enum: ACCOUNT_POTENTIALS },
          estimatedOpportunityValuePaise: { type: Number, min: 0 },
          existingBusinessPaise: { type: Number, min: 0 },
          strategicImportance: { type: Number, min: 1, max: 5 },
          relationshipHealth: { type: String, enum: RELATIONSHIP_HEALTH },
        },
        { _id: false },
      ),
      default: undefined,
    },

    source: { type: String, enum: ACCOUNT_SOURCES, default: 'manual' },
    importId: { type: ObjectId },
    // A saved copy of "when did anything last happen here"; only the activity service writes it.
    lastActivityAt: { type: Date },
    createdBy: { type: ObjectId, ref: 'User' },
    // Soft delete: a deleted account keeps its history but disappears from every screen.
    deletedAt: { type: Date, default: null },
    deletedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true, versionKey: false },
);

accountSchema.index({ nameKey: 1 });
accountSchema.index({ ownerId: 1 });
accountSchema.index({ assignedUserIds: 1 });
accountSchema.index({ status: 1 });
accountSchema.index({ tagIds: 1 });
accountSchema.index({ industry: 1 });
accountSchema.index({ region: 1 });
accountSchema.index({ lastActivityAt: -1 });
accountSchema.index({ createdAt: -1 });
accountSchema.index({ gstin: 1 }, { sparse: true });
accountSchema.index({ importId: 1 }, { sparse: true });

export const Account = mongoose.models.Account ?? mongoose.model('Account', accountSchema);
