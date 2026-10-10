import mongoose from 'mongoose';

// A lead (a deal): the central sales record (Master Prompt Section 10). On screen it is called
// a lead; the collection is `opportunities`. (`leads` is kept for the raw enquiries that arrive
// from ads and the website.)
// Schema only: no methods (decision 0005).

const { ObjectId } = mongoose.Schema.Types;

export const LEAD_SOURCES = ['manual', 'meta_ads', 'website', 'email', 'import', 'referral'];
export const FEASIBILITY = ['unknown', 'feasible', 'needs_study', 'not_feasible'];
export const BUDGET_STATUSES = ['unknown', 'no_budget', 'planned', 'approved'];
export const RISK_LEVELS = ['low', 'medium', 'high'];
export const SCOPE_LEVELS = ['machine', 'machine_group', 'line', 'department', 'process', 'plant'];
export const BUYING_ROLES = [
  'champion',
  'economic_buyer',
  'influencer',
  'gatekeeper',
  'user',
  'blocker',
];

const opportunitySchema = new mongoose.Schema(
  {
    // EGL-10001, EGL-10002, … Given once, never changed, never reused (decision 0012).
    leadCode: { type: String, required: true, unique: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    accountId: { type: ObjectId, ref: 'Account', required: true },
    plantId: { type: ObjectId, ref: 'Plant' },
    primaryContactId: { type: ObjectId, ref: 'Contact' },
    solutionCategoryIds: { type: [{ type: ObjectId, ref: 'SolutionCategory' }], default: [] },
    tagIds: { type: [{ type: ObjectId, ref: 'Tag' }], default: [] },

    // The day-to-day follow-up status (Settings → Statuses), side by side with the stage.
    leadStatusId: { type: ObjectId, ref: 'LeadStatus', required: true },
    // The pipeline stage. THE ONLY PLACE THE STAGE LIVES. Written only by the stage service
    // (services/stage.service.js), together with the three fields below it.
    stageId: { type: ObjectId, ref: 'PipelineStage', required: true },
    stageEnteredAt: { type: Date, required: true },
    // A saved copy of the stage's type, so open / won / lost can be filtered without a lookup.
    status: { type: String, enum: ['open', 'won', 'lost'], required: true, default: 'open' },
    closedAt: { type: Date },
    // Why it was won or lost: required by the stage service when a lead is closed.
    closeReason: { type: String, trim: true, maxlength: 500 },
    lostToCompetitor: { type: String, trim: true, maxlength: 200 },

    // Who works on it (decision 0008). No owner = unassigned: seen by the CEO and managers, who
    // assign it. A Sales Agent sees a lead only as its owner or when listed in assignedUserIds.
    ownerId: { type: ObjectId, ref: 'User', default: null },
    assignedUserIds: { type: [{ type: ObjectId, ref: 'User' }], default: [] },

    problemStatement: { type: String, trim: true, maxlength: 2000 },
    requirement: { type: String, trim: true, maxlength: 2000 },
    expectedImpact: { type: String, trim: true, maxlength: 2000 },
    // What in the plant the lead is about.
    scope: {
      type: new mongoose.Schema(
        {
          level: { type: String, enum: SCOPE_LEVELS },
          machineIds: { type: [{ type: ObjectId, ref: 'Machine' }], default: undefined },
          unitIds: { type: [{ type: ObjectId, ref: 'PlantUnit' }], default: undefined },
        },
        { _id: false },
      ),
      default: undefined,
    },
    // Money is stored as integer paise.
    estimatedValuePaise: { type: Number, min: 0 },
    probability: { type: Number, min: 0, max: 100 },
    expectedCloseDate: { type: Date },
    competitor: { type: String, trim: true, maxlength: 200 },
    technicalFeasibility: { type: String, enum: FEASIBILITY },
    budgetStatus: { type: String, enum: BUDGET_STATUSES },
    decisionTimeline: { type: String, trim: true, maxlength: 200 },
    // The people of the customer who matter for this lead, and their part in the decision.
    stakeholders: {
      type: [
        new mongoose.Schema(
          {
            contactId: { type: ObjectId, ref: 'Contact', required: true },
            buyingRole: { type: String, enum: BUYING_ROLES },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    nextAction: {
      type: new mongoose.Schema(
        { text: { type: String, trim: true, maxlength: 300 }, dueAt: { type: Date } },
        { _id: false },
      ),
      default: undefined,
    },
    risk: {
      type: new mongoose.Schema(
        {
          level: { type: String, enum: RISK_LEVELS },
          note: { type: String, trim: true, maxlength: 500 },
        },
        { _id: false },
      ),
      default: undefined,
    },
    // Saved copies written only by the AI module.
    aiScore: { type: Number, min: 0, max: 100 },
    aiRiskLevel: { type: String, enum: RISK_LEVELS },

    source: { type: String, enum: LEAD_SOURCES, required: true, default: 'manual' },
    sourceDetail: {
      type: new mongoose.Schema(
        { campaign: String, adSet: String, ad: String, form: String },
        { _id: false },
      ),
      default: undefined,
    },
    // The raw enquiry this lead was made from. Written only by the leads module.
    leadId: { type: ObjectId },
    importId: { type: ObjectId },
    // A saved copy of "when did anything last happen here"; only the activity service writes it.
    lastActivityAt: { type: Date },
    createdBy: { type: ObjectId, ref: 'User' },
    // The user who filled in the form that created this lead by hand (decision 0013).
    formFilledBy: { type: ObjectId, ref: 'User' },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true, versionKey: false },
);

opportunitySchema.index({ accountId: 1 });
opportunitySchema.index({ plantId: 1 }, { sparse: true });
opportunitySchema.index({ stageId: 1, ownerId: 1 });
opportunitySchema.index({ ownerId: 1 });
opportunitySchema.index({ assignedUserIds: 1 });
opportunitySchema.index({ leadStatusId: 1 });
opportunitySchema.index({ status: 1, expectedCloseDate: 1 });
opportunitySchema.index({ solutionCategoryIds: 1 });
opportunitySchema.index({ tagIds: 1 });
opportunitySchema.index({ estimatedValuePaise: 1 });
opportunitySchema.index({ source: 1 });
opportunitySchema.index({ lastActivityAt: -1 });
opportunitySchema.index({ stageEnteredAt: 1 });
opportunitySchema.index({ createdAt: -1 });

export const Opportunity =
  mongoose.models.Opportunity ?? mongoose.model('Opportunity', opportunitySchema);

// Every stage change of every lead, for "days in stage" and conversion reports.
// Written only by the stage service. Rows are added, never changed.
export const STAGE_CHANGE_VIA = [
  'pipeline',
  'opportunity_page',
  'account_page',
  'edit_form',
  'ai_suggestion',
  'automation',
  'import',
];

const stageHistorySchema = new mongoose.Schema(
  {
    opportunityId: { type: ObjectId, ref: 'Opportunity', required: true },
    // Empty for the first row: the stage the lead was created in.
    fromStageId: { type: ObjectId, ref: 'PipelineStage' },
    toStageId: { type: ObjectId, ref: 'PipelineStage', required: true },
    changedBy: { type: ObjectId, ref: 'User' },
    changedAt: { type: Date, required: true },
    msInPreviousStage: { type: Number },
    via: { type: String, enum: STAGE_CHANGE_VIA },
  },
  { versionKey: false },
);

stageHistorySchema.index({ opportunityId: 1, changedAt: 1 });
stageHistorySchema.index({ toStageId: 1, changedAt: 1 });
stageHistorySchema.index({ changedAt: 1 });

export const StageHistory =
  mongoose.models.StageHistory ??
  mongoose.model('StageHistory', stageHistorySchema, 'stage_history');
