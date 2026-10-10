import mongoose from 'mongoose';

// Inbound leads: the enquiries that arrive by themselves, from a Meta lead ad (and later from
// the website), and the forms they come from.
//   leads       the enquiry exactly as it arrived, and what it became (company, person, lead)
//   lead_forms  one form, and which of its questions fills which CRM field
// On screen the sales record is the "lead" (collection `opportunities`); these are its source.
// Schema only: no methods (decision 0005).

const { ObjectId } = mongoose.Schema.Types;

export const INBOUND_SOURCES = ['meta_ads', 'website'];
export const INBOUND_STATUSES = ['received', 'processed', 'duplicate', 'failed'];

// The CRM fields a form question can fill. "ignore" drops the answer; a question with no field
// is kept as a note on the lead.
export const LEAD_FORM_FIELDS = {
  'contact.name': 'Person: name',
  'contact.phone_number': 'Person: phone',
  'contact.email': 'Person: email',
  'contact.designation': 'Person: designation',
  'account.name': 'Company: name',
  'account.industry': 'Company: industry',
  'account.website': 'Company: website',
  'account.hq.city': 'Company: city',
  'account.hq.state': 'Company: state',
  'lead.requirement': 'Lead: what they need',
  ignore: 'Do not keep this answer',
};

const inboundLeadSchema = new mongoose.Schema(
  {
    source: { type: String, enum: INBOUND_SOURCES, required: true },
    // Meta's id of the lead ("leadgen_id"). The same lead is never stored twice.
    externalId: { type: String },
    formId: { type: ObjectId, ref: 'LeadForm' },
    campaign: {
      campaignId: String,
      campaignName: String,
      adSetId: String,
      adSetName: String,
      adId: String,
      adName: String,
      pageId: String,
      formName: String,
      platform: String,
    },
    // Meta's own time of the lead.
    metaCreatedAt: { type: Date },
    // The same person enquiring again is noted here on their first enquiry, not made a new lead.
    repeatEnquiries: {
      type: [
        {
          _id: false,
          source: String,
          formName: String,
          campaignName: String,
          externalId: String,
          at: Date,
        },
      ],
      default: [],
    },
    duplicateCount: { type: Number, default: 0 },
    lastDuplicateAt: { type: Date },
    isTest: { type: Boolean, default: false },
    // The answers exactly as received: [{ name, value }].
    rawFields: { type: mongoose.Schema.Types.Mixed },
    // The answers after mapping: { 'contact.name': …, 'contact.phone_number': …, … }.
    mapped: { type: mongoose.Schema.Types.Mixed },
    // The matching keys, kept apart so they can be indexed.
    phone_number: { type: String },
    email: { type: String },
    // Answers that fill no CRM field; also written as a note on the lead.
    unmappedNote: { type: String, maxlength: 5000 },
    status: { type: String, enum: INBOUND_STATUSES, required: true, default: 'received' },
    // What the enquiry became.
    contactId: { type: ObjectId, ref: 'Contact' },
    accountId: { type: ObjectId, ref: 'Account' },
    opportunityId: { type: ObjectId, ref: 'Opportunity' },
    assignedTo: { type: ObjectId, ref: 'User' },
    webhookEventId: { type: ObjectId, ref: 'WebhookEvent' },
    receivedAt: { type: Date, required: true },
    // Why it failed, in words a person can act on.
    error: { type: String, maxlength: 500 },
  },
  { timestamps: true, versionKey: false },
);

inboundLeadSchema.index(
  { externalId: 1 },
  { unique: true, partialFilterExpression: { externalId: { $exists: true } } },
);
inboundLeadSchema.index({ source: 1, receivedAt: -1 });
inboundLeadSchema.index({ status: 1 });
inboundLeadSchema.index({ phone_number: 1 }, { sparse: true });
inboundLeadSchema.index({ email: 1 }, { sparse: true });
inboundLeadSchema.index({ assignedTo: 1 });
inboundLeadSchema.index({ formId: 1 });

export const InboundLead =
  mongoose.models.InboundLead ?? mongoose.model('InboundLead', inboundLeadSchema, 'leads');

const leadFormSchema = new mongoose.Schema(
  {
    source: { type: String, enum: INBOUND_SOURCES, required: true },
    // Meta's id of the form.
    externalFormId: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    pageId: { type: String },
    // The questions seen on this form so far (their Meta names), for the mapping screen.
    questions: { type: [String], default: [] },
    // Which question fills which CRM field. A question that is not listed is mapped by its
    // name when that is clear (email, phone, full name, company), otherwise kept as a note.
    fieldMapping: {
      type: [
        {
          _id: false,
          question: { type: String, required: true },
          crmField: { type: String, required: true, enum: Object.keys(LEAD_FORM_FIELDS) },
        },
      ],
      default: [],
    },
    defaultSolutionCategoryId: { type: ObjectId, ref: 'SolutionCategory' },
    // Leads of this form always go to this person; it comes before the assignment rule.
    defaultOwnerId: { type: ObjectId, ref: 'User' },
    // A switched-off form still stores its enquiries, but makes no company, person or lead.
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true, versionKey: false },
);

leadFormSchema.index({ source: 1, externalFormId: 1 }, { unique: true });

export const LeadForm =
  mongoose.models.LeadForm ?? mongoose.model('LeadForm', leadFormSchema, 'lead_forms');
