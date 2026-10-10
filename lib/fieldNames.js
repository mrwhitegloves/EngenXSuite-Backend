import { normalizePhone } from './phone.js';

// One name per fact, whatever the source called it (founder decision 0013).
// Meta lead forms, Excel/CSV files and other sources name the same thing in many ways:
// "email", "E-mail", "work_email", "Email ID", "mail" … or "phone", "Mobile No.", "tel",
// "WhatsApp number", "phone_number" …. Before anything is saved, those names are turned into
// the two names the database uses:
//
//     email          every email address field
//     phone_number   every phone / mobile / WhatsApp number field
//
// Every inbound path (Meta lead webhook, file import, forms) must pass its fields through
// normalizeInboundFields(); no other code decides what an email or phone column is called.

export const EMAIL_FIELD = 'email';
export const PHONE_FIELD = 'phone_number';

// Whole words that mean "phone". Matched as words, never as parts of a word, so that
// "hotel" (…tel), "model" or "mobility partner" are left alone.
const PHONE_WORDS = [
  'phone',
  'phones',
  'phoneno',
  'phonenumber',
  'mobile',
  'mobileno',
  'mobilenumber',
  'mob',
  'cell',
  'cellphone',
  'telephone',
  'tel',
  'whatsapp',
  'whatsappno',
  'whatsappnumber',
  'contactno',
  'contactnumber',
];
const EMAIL_WORDS = ['email', 'emails', 'emailid', 'emailaddress', 'mail', 'mailid'];

/** "Work E-mail (official)" → ["work", "email", "official"] */
function wordsOf(name) {
  return (
    String(name ?? '')
      // "E-mail" and "e mail" are one word; so are "workEmail" → "work Email".
      .replace(/e[-\s_]mail/gi, 'email')
      // "WhatsApp" is one word, not "Whats" + "App".
      .replace(/whats[-\s_]?app/gi, 'whatsapp')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
  );
}

/**
 * The database name for a source's field name, or null when it is neither an email nor a phone.
 * @param {string} name  For example "Work E-mail", "mobile_no", "WhatsApp Number", "City"
 * @returns {'email' | 'phone_number' | null}
 */
export function canonicalFieldName(name) {
  const words = wordsOf(name);
  // "contact number" / "contact no" written as two words.
  const joined = words.join('');
  if (words.some((word) => EMAIL_WORDS.includes(word)) || EMAIL_WORDS.includes(joined)) {
    return EMAIL_FIELD;
  }
  if (words.some((word) => PHONE_WORDS.includes(word)) || PHONE_WORDS.includes(joined)) {
    return PHONE_FIELD;
  }
  return null;
}

const cleanEmail = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase();

/**
 * Turn a source's fields into the database's names and forms.
 *
 * - every email-like field becomes `email` (trimmed, lowercase)
 * - every phone-like field becomes `phone_number` (international form, see lib/phone.js;
 *   a number that cannot be understood is kept as typed, so nothing is lost)
 * - when a source has a second, DIFFERENT email or phone, it is kept under its own cleaned
 *   name (for example `whatsapp_number`), never thrown away and never overwriting the first
 * - every other field keeps its name and value
 *
 * @param {Record<string, unknown> | { name: string, values?: unknown[], value?: unknown }[]} input
 *        A plain object (a spreadsheet row), or the list Meta sends: [{ name, values: [...] }]
 * @returns {{ fields: Record<string, unknown>, renamed: { from: string, to: string }[] }}
 */
export function normalizeInboundFields(input) {
  const pairs = Array.isArray(input)
    ? input.map((item) => [item?.name, item?.values?.[0] ?? item?.value ?? null])
    : Object.entries(input ?? {});

  const fields = {};
  const renamed = [];
  for (const [rawName, rawValue] of pairs) {
    const name = String(rawName ?? '').trim();
    if (!name) continue;
    const canonical = canonicalFieldName(name);
    if (!canonical) {
      fields[name] = rawValue;
      continue;
    }

    const isEmpty = rawValue === null || rawValue === undefined || String(rawValue).trim() === '';
    const value =
      canonical === EMAIL_FIELD
        ? cleanEmail(rawValue)
        : (normalizePhone(rawValue) ?? String(rawValue ?? '').trim());
    if (isEmpty) {
      // An empty column never claims the name and never erases a value found elsewhere.
      if (!(canonical in fields)) fields[canonical] = null;
      continue;
    }
    if (fields[canonical] === undefined || fields[canonical] === null) {
      fields[canonical] = value;
      if (name !== canonical) renamed.push({ from: name, to: canonical });
    } else if (fields[canonical] !== value) {
      // A second, different address or number: keep it under its own tidy name.
      const ownName = wordsOf(name).join('_');
      fields[ownName === canonical ? `other_${canonical}` : ownName] = value;
    }
  }
  return { fields, renamed };
}
