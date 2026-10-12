import { IMPORT_FIELDS, IMPORT_FIELD_NAMES } from '../constants/importFields.js';
import { badRequest } from '../lib/errors.js';
import {
  EMAIL_FIELD,
  PHONE_FIELD,
  canonicalFieldName,
  normalizeInboundFields,
} from '../lib/fieldNames.js';
import { COMPANY_SIZES } from '../models/account.model.js';
import { createAccountBody } from '../validation/accounts.js';
import { createContactBody } from '../validation/contacts.js';

// Reading an imported file, without touching the database: its headings, which column fills
// which field, and what one row says about a company, a person and (when the file has lead
// columns) a lead. The same checks as the forms are used (validation/accounts.js,
// validation/contacts.js), so a row that imports is a row the form would have accepted.

const PERSON_PREFIX = 'contact.';
const LEAD_PREFIX = 'lead.';
const fieldOf = (field) => IMPORT_FIELDS.find((item) => item.field === field);
const labelOf = (field) => fieldOf(field)?.label ?? field;
const isMulti = (field) => Boolean(fieldOf(field)?.multi);
const headingKey = (heading) => heading.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * The headings of a file as they are shown and stored: trimmed, never empty, never twice.
 * "Phone", "", "Phone" → "Phone", "Column 2", "Phone (2)".
 * @param {string[]} cells  The first row of the file
 */
export function uniqueHeaders(cells) {
  const seen = new Map();
  return cells.map((cell, index) => {
    const base = String(cell ?? '').trim() || `Column ${index + 1}`;
    const count = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

/**
 * Headings of an exported lead list that no alias names: its comment columns, and the
 * questions of a lead form (a heading that ends with "?").
 */
function leadColumnField(column) {
  const key = headingKey(column);
  if (/^(comments?|notes?|remarks?)\d+(text)?$/.test(key)) return 'lead.note';
  if (!column.trim().endsWith('?')) return null;
  if (/role|designation/.test(key)) return 'contact.designation';
  if (/industry/.test(key)) return 'industry';
  // (A budget question may speak of "this problem": it is not the problem itself.)
  if (/challenge|painpoint/.test(key) || (/problem/.test(key) && !/budget/.test(key))) {
    return 'lead.problemStatement';
  }
  if (/howsoon|lookingtodo|timeline|whendoyou/.test(key)) return 'lead.decisionTimeline';
  return 'lead.answer';
}

/**
 * A first guess of which column fills which field, from the headings alone.
 * @param {string[]} headers
 * @returns {{ column: string, field: string }[]} In the order of the columns
 */
export function suggestMapping(headers) {
  const chosen = new Map(); // column → field
  const isFree = (column) => !chosen.has(column);
  const isTaken = (field) => [...chosen.values()].includes(field);
  // A field is given once, except the ones that may be chosen for several columns.
  const give = (field, column) => {
    if (isFree(column) && (isMulti(field) || !isTaken(field))) chosen.set(column, field);
  };

  // 1. Headings that name a field.
  for (const column of headers) {
    const match = IMPORT_FIELDS.find((item) => item.aliases.includes(headingKey(column)));
    if (match) give(match.field, column);
  }
  // 2. A plain "Name" is the company, unless another column already names the company.
  for (const column of headers) {
    if (headingKey(column) === 'name') give(isTaken('name') ? 'contact.name' : 'name', column);
  }
  // 3. Comment columns and the questions of a lead form.
  for (const column of headers.filter(isFree)) {
    const field = leadColumnField(column);
    if (field) give(field, column);
  }
  // 4. Email and phone columns, whatever they are called. They belong to the person when the
  //    file names a person, and to the company otherwise (or when the heading says so).
  //    A "normalized" copy of a phone column is the same number again: left out.
  const hasPerson = isTaken('contact.name');
  for (const column of headers.filter(isFree)) {
    const kind = canonicalFieldName(column);
    if (!kind || /normali[sz]ed/i.test(column)) continue;
    const forPerson = hasPerson && !/company|office|business|firm/i.test(column);
    const choices = {
      [EMAIL_FIELD]: forPerson ? ['contact.email', 'email'] : ['email'],
      [PHONE_FIELD]: forPerson
        ? ['contact.phone_number', 'contact.alt_phone_number', 'phone_number']
        : ['phone_number'],
    }[kind];
    const field = choices.find((choice) => !isTaken(choice));
    if (field) give(field, column);
  }

  return headers
    .filter((column) => chosen.has(column))
    .map((column) => ({ column, field: chosen.get(column) }));
}

/**
 * Check a mapping the person chose and turn it into column positions.
 * @param {{ column: string, field: string }[]} mapping
 * @param {string[]} headers
 * @returns {{ index: number, field: string, column: string }[]}  In the order of the file
 */
export function toColumns(mapping, headers) {
  const problem = (message) => badRequest(message, [{ field: 'mapping', message }]);
  const fields = mapping.map((item) => item.field);
  const columns = mapping.map((item) => item.column);

  const unknownField = fields.find((field) => !IMPORT_FIELD_NAMES.includes(field));
  if (unknownField) throw problem(`"${unknownField}" is not a field a column can fill.`);
  const unknownColumn = columns.find((column) => !headers.includes(column));
  if (unknownColumn) throw problem(`The file has no column "${unknownColumn}".`);
  const twice = (values) => values.find((value, index) => values.indexOf(value) !== index);
  const fieldTwice = twice(fields.filter((field) => !isMulti(field)));
  if (fieldTwice) throw problem(`"${labelOf(fieldTwice)}" is chosen for two columns.`);
  if (twice(columns)) throw problem(`The column "${twice(columns)}" is used twice.`);
  if (!fields.includes('name')) throw problem('Choose the column that holds the company name.');
  const hasPersonField = fields.some((field) => field.startsWith(PERSON_PREFIX));
  if (hasPersonField && !fields.includes('contact.name')) {
    throw problem('Choose the column with the person’s name, or leave the person columns out.');
  }
  return mapping
    .map((item) => ({
      index: headers.indexOf(item.column),
      field: item.field,
      column: item.column,
    }))
    .sort((a, b) => a.index - b.index);
}

/** "250", "1,200 people" or "51-200" → one of the size groups; null when it cannot be read. */
function toCompanySize(value) {
  const tidy = value.replace(/\s+/g, '').replace(/[–—]/g, '-');
  const named = COMPANY_SIZES.find((size) => tidy.startsWith(size));
  if (named) return named;
  const number = Number(tidy.replace(/,/g, '').match(/^\d+/)?.[0]);
  if (!Number.isInteger(number) || number < 1) return null;
  if (number <= 50) return '1-50';
  if (number <= 200) return '51-200';
  if (number <= 1000) return '201-1000';
  if (number <= 5000) return '1001-5000';
  return '5000+';
}

/** "₹ 2,50,00,000" or "25000000.50" (rupees) → paise; null when it is not a plain number. */
function toPaise(value) {
  const tidy = value.replace(/₹|rs\.?|inr|,|\s/gi, '');
  return /^\d+(\.\d{1,2})?$/.test(tidy) ? Math.round(Number(tidy) * 100) : null;
}

const zodMessages = (error, prefix) =>
  error.issues.map((issue) => `${labelOf(`${prefix}${issue.path.join('.')}`)}: ${issue.message}`);

const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);
/**
 * A form's coded answer as words: "plant_head" → "Plant head", "a_b|c_d" → "A b, c d".
 * Text that is written normally (it has spaces) is left as it is.
 */
export function tidyAnswer(value) {
  if (!value.includes('_') || /\s/.test(value)) return value;
  return capitalise(value.replace(/\|/g, ', ').replace(/_/g, ' ').replace(/\s+/g, ' ').trim());
}
/** A form's question as it was asked: "what_is_your_role?" → "What is your role?". */
const tidyQuestion = (heading) => capitalise(heading.replace(/_/g, ' ').trim());
/** A phone number as exports write it: "p:+9198…" and "'+9198…" → "+9198…". */
const tidyPhone = (value) => value.replace(/^['’`]+/, '').replace(/^p:\s*/i, '');
// Fields whose value may be a form's coded answer.
const CODED = ['industry', 'contact.designation', 'lead.problemStatement', 'lead.decisionTimeline'];

/**
 * What one row of the file says.
 * @param {string[]} cells
 * @param {{ index: number, field: string, column: string }[]} columns  From toColumns()
 * @returns {{ account: object | null, contact: object | null, lead: object | null,
 *             errors: string[] }}
 *          account / contact are ready for createAccount() / createContacts(); contact is null
 *          when the row names no person. lead is null when the mapping has no lead column;
 *          else { name?, status?, createdAt?, requirement?, problemStatement?,
 *          decisionTimeline?, campaign?, adSet?, ad?, form?, externalId?, notes: string[],
 *          answers: { question, answer }[] }. With errors, nothing of the row is saved.
 */
export function readRow(cells, columns) {
  const company = {};
  const person = {};
  const lead = { notes: [], answers: [] };
  for (const { index, field, column } of columns) {
    let value = String(cells[index] ?? '').trim();
    if (value === '') continue;
    if (CODED.includes(field)) value = tidyAnswer(value);
    if (field === 'lead.note') {
      lead.notes.push(value.slice(0, 5000));
    } else if (field === 'lead.answer') {
      lead.answers.push({ question: tidyQuestion(column), answer: tidyAnswer(value) });
    } else if (field.startsWith(LEAD_PREFIX)) {
      // Chosen for several columns: the first filled one wins.
      lead[field.slice(LEAD_PREFIX.length)] ??= value;
    } else if (field.startsWith(PERSON_PREFIX)) {
      person[field.slice(PERSON_PREFIX.length)] ??= value;
    } else {
      company[field] ??= value;
    }
  }
  for (const record of [company, person]) {
    for (const key of ['phone_number', 'alt_phone_number']) {
      if (record[key]) record[key] = tidyPhone(record[key]);
    }
  }
  // Emails and phone numbers get their one stored form (decision 0013).
  const companyFields = normalizeInboundFields(company).fields;
  const personFields = normalizeInboundFields(person).fields;

  const errors = [];
  const account = { name: '' };
  for (const [field, value] of Object.entries(companyFields)) {
    if (value === null) continue;
    if (field.startsWith('hq.')) {
      account.hq = { ...account.hq, [field.slice(3)]: value };
    } else if (field === 'companySize') {
      account.companySize = toCompanySize(value);
      if (!account.companySize) {
        errors.push(`${labelOf(field)}: use a number, or one of ${COMPANY_SIZES.join(', ')}`);
      }
    } else if (field === 'annualRevenueRupees') {
      account.annualRevenuePaise = toPaise(value);
      if (account.annualRevenuePaise === null) {
        errors.push(`${labelOf(field)}: enter a plain number, for example 25000000`);
      }
    } else {
      account[field] = value;
    }
  }
  const parsedAccount = createAccountBody.safeParse(account);
  if (!parsedAccount.success) errors.push(...zodMessages(parsedAccount.error, ''));

  let contact = null;
  if (Object.values(personFields).some((value) => value !== null)) {
    const filled = Object.fromEntries(
      Object.entries(personFields).filter(([, value]) => value !== null),
    );
    const parsedContact = createContactBody.safeParse({ name: '', ...filled });
    if (parsedContact.success) contact = parsedContact.data;
    else errors.push(...zodMessages(parsedContact.error, PERSON_PREFIX));
  }

  const hasLeadColumns = columns.some((item) => item.field.startsWith(LEAD_PREFIX));
  if (hasLeadColumns) {
    if (lead.createdAt) {
      const moment = new Date(lead.createdAt);
      if (Number.isNaN(moment.getTime())) {
        errors.push(`${labelOf('lead.createdAt')}: "${lead.createdAt}" is not a date`);
      } else {
        lead.createdAt = moment;
      }
    }
    // The source's own prefix ("l:1234") is not part of the id.
    if (lead.externalId)
      lead.externalId = lead.externalId.replace(/^[a-z]{1,3}:/i, '').slice(0, 100);
    for (const [key, limit] of [
      ['name', 150],
      ['requirement', 2000],
      ['problemStatement', 2000],
      ['decisionTimeline', 200],
    ]) {
      if (lead[key]) lead[key] = lead[key].slice(0, limit);
    }
  }

  if (errors.length > 0) return { account: null, contact: null, lead: null, errors };
  return {
    account: parsedAccount.data,
    contact,
    lead: hasLeadColumns ? lead : null,
    errors,
  };
}
