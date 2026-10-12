// Takes out of a text what must never be sent to a model: tax ids, bank details, card numbers
// and secrets. Every prompt goes through redact() in runAiTask(); a task never sends text itself.
//
// It errs on the side of removing: a harmless code that looks like a PAN is also replaced.

const RULES = [
  // GSTIN: 15 characters, for example 27AAPFU0939F1ZV. Before PAN: a GSTIN contains a PAN.
  [/\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]\b/gi, '[GSTIN removed]'],
  // PAN: 5 letters, 4 digits, 1 letter.
  [/\b[A-Z]{5}\d{4}[A-Z]\b/gi, '[PAN removed]'],
  // IFSC: 4 letters, a zero, 6 characters.
  [/\b[A-Z]{4}0[A-Z\d]{6}\b/gi, '[IFSC removed]'],
  // A bank account number: 9 to 18 digits soon after a word that says so.
  [
    /\b(account|acct|a\/c|bank)([^\n\d]{0,25}?)\d[\d -]{7,20}\d\b/gi,
    (match, word, between) => `${word}${between}[account number removed]`,
  ],
  // A card number: 13 to 19 digits in groups of four.
  [/\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,7}\b/g, '[card number removed]'],
  // Keys and tokens by their well-known beginnings, and "Bearer …".
  [/\b(sk|pk|rk|ghp|gho|xox[abp]|AKIA)[-_][-_A-Za-z0-9]{12,}/g, '[secret removed]'],
  [/\bAKIA[A-Z0-9]{12,}\b/g, '[secret removed]'],
  [/\bBearer\s+[-._~+/A-Za-z0-9]{16,}=*/g, 'Bearer [secret removed]'],
  // A password written out: "password: hunter2".
  [/\b(password|passwd|pwd)(\s*[:=]\s*)\S+/gi, (match, word, sign) => `${word}${sign}[removed]`],
];

/**
 * @param {string} text
 * @returns {string} The text without tax ids, bank details, card numbers and secrets
 */
export function redact(text) {
  let clean = String(text ?? '');
  for (const [pattern, replacement] of RULES) clean = clean.replace(pattern, replacement);
  return clean;
}
