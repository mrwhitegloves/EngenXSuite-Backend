// A company name in a comparable form, used to notice that "Tata Steel Ltd." and
// "TATA STEEL LIMITED" are the same company (on create and on import).
// It only finds likely duplicates for a person to confirm; it never merges anything by itself.

// Legal-form words that people add or leave out.
const LEGAL_WORDS = [
  'private',
  'pvt',
  'limited',
  'ltd',
  'llp',
  'inc',
  'incorporated',
  'corporation',
  'corp',
  'company',
  'co',
  'india',
  'the',
];

/**
 * @param {string} name
 * @returns {string} lowercase letters and digits of the name without legal-form words
 */
export function toNameKey(name) {
  const words = String(name ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    // Everything that is not a letter or digit (in any script) becomes a space.
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const meaningful = words.filter((word) => !LEGAL_WORDS.includes(word));
  // A name made only of such words (for example "The Company") keeps them.
  return (meaningful.length > 0 ? meaningful : words).join('');
}
