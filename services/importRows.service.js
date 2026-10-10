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
// which field, and what one row says about a company and a person. The same checks as the
// forms are used (validation/accounts.js, validation/contacts.js), so a row that imports is a
// row the form would have accepted.

const PERSON_PREFIX = 'contact.';
const labelOf = (field) => IMPORT_FIELDS.find((item) => item.field === field)?.label ?? field;
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
 * A first guess of which column fills which field, from the headings alone.
 * @param {string[]} headers
 * @returns {{ column: string, field: string }[]} In the order of the columns
 */
export function suggestMapping(headers) {
  const columnOf = new Map(); // field → column
  const isFree = (column) => ![...columnOf.values()].includes(column);
  const give = (field, column) => {
    if (!columnOf.has(field) && isFree(column)) columnOf.set(field, column);
  };

  // 1. Headings that name a field.
  for (const column of headers) {
    const match = IMPORT_FIELDS.find((item) => item.aliases.includes(headingKey(column)));
    if (match) give(match.field, column);
  }
  // 2. A plain "Name" is the company, unless another column already names the company.
  for (const column of headers) {
    if (headingKey(column) === 'name') give(columnOf.has('name') ? 'contact.name' : 'name', column);
  }
  // 3. Email and phone columns, whatever they are called. They belong to the person when the
  //    file names a person, and to the company otherwise (or when the heading says so).
  const hasPerson = columnOf.has('contact.name');
  for (const column of headers.filter(isFree)) {
    const kind = canonicalFieldName(column);
    if (!kind) continue;
    const forPerson = hasPerson && !/company|office|business|firm/i.test(column);
    const choices = {
      [EMAIL_FIELD]: forPerson ? ['contact.email', 'email'] : ['email'],
      [PHONE_FIELD]: forPerson
        ? ['contact.phone_number', 'contact.alt_phone_number', 'phone_number']
        : ['phone_number'],
    }[kind];
    const field = choices.find((choice) => !columnOf.has(choice));
    if (field) give(field, column);
  }

  const fieldOf = new Map([...columnOf].map(([field, column]) => [column, field]));
  return headers
    .filter((column) => fieldOf.has(column))
    .map((column) => ({ column, field: fieldOf.get(column) }));
}

/**
 * Check a mapping the person chose and turn it into column positions.
 * @param {{ column: string, field: string }[]} mapping
 * @param {string[]} headers
 * @returns {{ index: number, field: string }[]}
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
  if (twice(fields)) throw problem(`"${labelOf(twice(fields))}" is chosen for two columns.`);
  if (twice(columns)) throw problem(`The column "${twice(columns)}" is used twice.`);
  if (!fields.includes('name')) throw problem('Choose the column that holds the company name.');
  const hasPersonField = fields.some((field) => field.startsWith(PERSON_PREFIX));
  if (hasPersonField && !fields.includes('contact.name')) {
    throw problem('Choose the column with the person’s name, or leave the person columns out.');
  }
  return mapping.map((item) => ({ index: headers.indexOf(item.column), field: item.field }));
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

/**
 * What one row of the file says.
 * @param {string[]} cells
 * @param {{ index: number, field: string }[]} columns  From toColumns()
 * @returns {{ account: object | null, contact: object | null, errors: string[] }}
 *          account / contact are ready for createAccount() / createContacts(); contact is null
 *          when the row names no person. With errors, nothing of the row is saved.
 */
export function readRow(cells, columns) {
  const company = {};
  const person = {};
  for (const { index, field } of columns) {
    const value = String(cells[index] ?? '').trim();
    if (value === '') continue;
    if (field.startsWith(PERSON_PREFIX)) person[field.slice(PERSON_PREFIX.length)] = value;
    else company[field] = value;
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

  if (errors.length > 0) return { account: null, contact: null, errors };
  return { account: parsedAccount.data, contact, errors };
}
