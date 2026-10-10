// Writing CSV files that open correctly in Excel and Google Sheets. Used by every export.

// A cell that starts with one of these is run as a formula by spreadsheet programs. A company
// named "=HYPERLINK(...)" must stay text, so such cells get a leading apostrophe.
const FORMULA_START = /^[=+\-@\t\r]/;

// The byte-order mark: an invisible first character that tells Excel the file is UTF-8, so the
// letters of every language (and the rupee sign) are read correctly.
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

function toCell(value) {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  // Quotes are doubled; a cell with a comma, quote or line break is wrapped in quotes.
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * @param {{ header: string, value: (row: object) => unknown }[]} columns
 * @param {object[]} rows
 * @returns {string} The file's text, starting with the byte-order mark
 */
export function toCsv(columns, rows) {
  const lines = [columns.map((column) => toCell(column.header)).join(',')];
  for (const row of rows) lines.push(columns.map((column) => toCell(column.value(row))).join(','));
  return `${BYTE_ORDER_MARK}${lines.join('\r\n')}\r\n`;
}
