// The fields a column of an imported file can fill. A row of the file is one company and,
// optionally, one person at that company (fields that start with "contact.").
//
// `aliases` are column headings that mean this field, written in lowercase letters and digits
// only ("Company Name" → "companyname"). They are used to SUGGEST a mapping; the person always
// confirms it. Email and phone columns are recognised by lib/fieldNames.js, whatever they are
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
  { field: 'industry', label: 'Industry', aliases: ['industry', 'sector', 'segment', 'vertical'] },
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
    aliases: ['designation', 'title', 'jobtitle', 'position', 'role'],
  },
  {
    field: 'contact.department',
    label: 'Person department',
    aliases: ['department', 'dept', 'function'],
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
    aliases: ['personlinkedin', 'contactlinkedin', 'linkedinprofile', 'profileurl'],
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
