// Writing CSV files that open correctly in Excel and Google Sheets (used by every export), and
// reading the CSV files people upload (used by the import).

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

/**
 * The text of an uploaded file. Files saved by Excel as plain "CSV" are not UTF-8 but
 * Windows-1252; reading those as UTF-8 would turn "é" or "₹" into broken characters.
 * @param {Buffer} buffer
 * @returns {string} Without the byte-order mark
 */
export function decodeCsv(buffer) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    text = new TextDecoder('windows-1252').decode(buffer);
  }
  return text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
}

// Excel writes ";" between cells in countries where "," is the decimal sign, and some tools
// write tabs. The separator is the candidate that appears most in the first line.
function detectSeparator(text) {
  const firstLine = text.slice(0, text.search(/\r|\n|$/));
  const count = (separator) => firstLine.split(separator).length - 1;
  return [',', ';', '\t'].reduce((best, candidate) =>
    count(candidate) > count(best) ? candidate : best,
  );
}

/**
 * Read CSV text into rows of cells. Follows the usual rules: a cell in quotes may contain the
 * separator, line breaks and doubled quotes. Rows with no text at all are left out.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const separator = detectSeparator(text);
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  const endRow = () => {
    row.push(cell);
    cell = '';
    if (row.some((value) => value.trim() !== '')) rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char !== '"') cell += char;
      else if (text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else inQuotes = false;
    } else if (char === '"' && cell === '') {
      inQuotes = true;
    } else if (char === separator) {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      // "\r\n" is one line end, not two.
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      endRow();
    } else {
      cell += char;
    }
  }
  if (cell !== '' || row.length > 0) endRow();
  return rows;
}
