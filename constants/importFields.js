// The fields a column of an imported file can fill. A row of the file is one company and,
// optionally, one person at that company (fields that start with "contact.").
//
// `aliases` are column headings that mean this field, written in lowercase letters and digits
// only ("Company Name" → "companyname"). They are used to SUGGEST a mapping; the person always
// confirms it. `multi`: the field may be chosen for several columns: 'first' = the first filled
// column of a row wins (two files' worth of columns in one sheet), 'all' = every one is kept. Email and phone columns are recognised by lib/fieldNames.js, whatever they are
// called (decision 0013).

export const IMPORT_FIELDS = [
  {
    field: 'name',
    label: 'Company name',
    group: 'Company',
    required: true,
    aliases: [
      'company',
      'companyname',
      'organisation',
      'organization',
      'organisationname',
      'organizationname',
      'account',
      'accountname',
      'firm',
      'firmname',
      'business',
      'businessname',
      'client',
      'clientname',
      'customer',
      'customername',
    ],
  },
  {
    field: 'industry',
    label: 'Industry',
    multi: 'first',
    aliases: ['industry', 'sector', 'segment', 'vertical'],
  },
  { field: 'companyType', label: 'Group / company type', aliases: ['companytype', 'type'] },
  {
    field: 'website',
    label: 'Website',
    aliases: ['website', 'web', 'url', 'site', 'companywebsite', 'websiteurl'],
  },
  {
    field: 'linkedinUrl',
    label: 'Company LinkedIn page',
    aliases: ['linkedin', 'linkedinurl', 'linkedinpage', 'companylinkedin'],
  },
  {
    field: 'phone_number',
    label: 'Company phone',
    aliases: ['companyphone', 'officephone', 'landline', 'officenumber', 'boardline'],
  },
  {
    field: 'email',
    label: 'Company email',
    aliases: ['companyemail', 'officeemail', 'generalemail'],
  },
  {
    field: 'description',
    label: 'About the company',
    aliases: ['description', 'about', 'notes', 'note', 'remarks', 'comments'],
  },
  {
    field: 'hq.addressLine',
    label: 'Address',
    aliases: ['address', 'addressline', 'street', 'officeaddress'],
  },
  { field: 'hq.city', label: 'City', aliases: ['city', 'town', 'location'] },
  { field: 'hq.state', label: 'State', aliases: ['state', 'province'] },
  { field: 'hq.country', label: 'Country', aliases: ['country'] },
  {
    field: 'hq.pincode',
    label: 'PIN code',
    aliases: ['pincode', 'pin', 'zip', 'zipcode', 'postalcode', 'postcode'],
  },
  { field: 'region', label: 'Region', aliases: ['region', 'zone', 'territory'] },
  {
    field: 'companySize',
    label: 'Company size (people)',
    aliases: ['companysize', 'employees', 'employeecount', 'noofemployees', 'headcount', 'size'],
  },
  {
    field: 'annualRevenueRupees',
    label: 'Yearly revenue (₹)',
    aliases: ['revenue', 'annualrevenue', 'yearlyrevenue', 'turnover', 'annualturnover'],
  },
  { field: 'gstin', label: 'GSTIN', aliases: ['gstin', 'gst', 'gstno', 'gstnumber'] },
  { field: 'pan', label: 'PAN', aliases: ['pan', 'panno', 'pannumber'] },

  {
    field: 'contact.name',
    label: 'Person name',
    group: 'Person',
    aliases: [
      'contactname',
      'contactperson',
      'contact',
      'person',
      'personname',
      'fullname',
      'poc',
      'pocname',
      'spoc',
    ],
  },
  {
    field: 'contact.designation',
    label: 'Person designation',
    multi: 'first',
    aliases: ['designation', 'title', 'jobtitle', 'position', 'role'],
  },
  {
    field: 'contact.department',
    label: 'Person department',
    multi: 'first',
    aliases: ['department', 'departments', 'dept', 'function'],
  },
  { field: 'contact.phone_number', label: 'Person phone', aliases: [] },
  {
    field: 'contact.alt_phone_number',
    label: 'Person other phone',
    aliases: ['altphone', 'alternatephone', 'otherphone', 'phone2', 'mobile2', 'secondaryphone'],
  },
  { field: 'contact.email', label: 'Person email', aliases: [] },
  {
    field: 'contact.linkedinUrl',
    label: 'Person LinkedIn profile',
    aliases: [
      'personlinkedin',
      'personlinkedinurl',
      'contactlinkedin',
      'linkedinprofile',
      'profileurl',
    ],
  },

  // The lead. A file with any of these columns makes a lead for each row (company + person +
  // lead), unless the import says for which rows not to (services/importLeads.service.js).
  {
    field: 'lead.name',
    label: 'What the lead is about',
    group: 'Lead',
    aliases: ['leadname', 'opportunity', 'opportunityname', 'deal', 'dealname'],
  },
  // Matched by name against Settings → Statuses (lead statuses).
  { field: 'lead.status', label: 'Lead status', aliases: ['status', 'leadstatus'] },
  {
    field: 'lead.createdAt',
    label: 'Date the lead came in',
    aliases: ['createdtime', 'createdat', 'createddate', 'leaddate', 'submittedat'],
  },
  { field: 'lead.requirement', label: 'What they need', aliases: ['requirement', 'enquiry'] },
  {
    field: 'lead.problemStatement',
    label: 'The problem today',
    multi: 'first',
    aliases: ['problem', 'challenge', 'painpoint'],
  },
  {
    field: 'lead.decisionTimeline',
    label: 'They decide',
    multi: 'first',
    aliases: ['decisiontimeline', 'timeline'],
  },
  { field: 'lead.campaign', label: 'Campaign', aliases: ['campaign', 'campaignname'] },
  { field: 'lead.adSet', label: 'Ad set', aliases: ['adset', 'adsetname'] },
  { field: 'lead.ad', label: 'Ad', aliases: ['ad', 'adname'] },
  { field: 'lead.form', label: 'Lead form', aliases: ['form', 'formname'] },
  {
    field: 'lead.externalId',
    label: 'Id of the lead at its source',
    aliases: ['leadgenid', 'leadid', 'externalid'],
  },
  // These two can be chosen for many columns: each filled one becomes (part of) a note.
  { field: 'lead.note', label: 'Note on the lead', multi: 'all', aliases: [] },
  {
    field: 'lead.answer',
    label: 'Answer from the form (kept in a note)',
    multi: 'all',
    aliases: [],
  },
].map((item, index, list) => ({
  ...item,
  // A field without its own group belongs to the group of the field before it.
  group: item.group ?? list.findLast((earlier, at) => at < index && earlier.group).group,
}));

export const IMPORT_FIELD_NAMES = IMPORT_FIELDS.map((item) => item.field);

// Limits of one file. Larger lists are split into several files.
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5000;
