import { z } from 'zod';
import { runAiTask } from '../runTask.js';

// AI task: which column of an uploaded file fills which CRM field. It sees the headings and a
// few sample values with their digits and email names masked, never the whole file. The answer
// is a suggestion on the import screen: the person checks it, and nothing is imported by it.

export const SUGGEST_CSV_MAPPING_VERSION = 'suggestCsvMapping/v1';

export const csvMappingSchema = z.object({
  mapping: z
    .array(
      z.object({
        column: z.string().min(1).max(200),
        // The key of a CRM field, or null for "do not import".
        field: z.string().max(80).nullable(),
      }),
    )
    .max(200),
});

const SYSTEM = `You match the columns of a spreadsheet to the fields of a CRM for a company that sells to factories in India.
Each row of the spreadsheet is one company and, optionally, one person at that company.

You get JSON with:
- "columns": the spreadsheet's columns, each with its heading and a few sample values. Digits are replaced by 9 and email names by x, so only the shape of a value is real.
- "fields": the CRM fields a column can fill, each with a key, a label and a group. Fields whose key starts with "contact." are about the person.

Rules:
- For every column answer the key of the ONE field it fills, or null when no field fits or you are not sure.
- Use only keys from "fields". Never invent a key.
- A field can be filled by one column only. When two columns fit the same field, give it to the better one and answer null for the other.
- Decide from the heading first, then from the shape of the samples.
- A person's name, designation, phone and email go to the "contact." fields; a company's own phone, email and website go to the company fields.

Answer with one JSON object and nothing else:
{ "mapping": [ { "column": "the heading exactly as given", "field": "a field key or null" } ] }`;

/** Keeps the shape of a value and hides what it says: digits become 9, an email's name x. */
export function maskSample(value) {
  return String(value ?? '')
    .slice(0, 60)
    .replace(/[^\s@,;]+@/g, (name) => `${'x'.repeat(Math.min(name.length - 1, 6))}@`)
    .replace(/\d/g, '9');
}

/**
 * @param {{ headers: string[], sampleRows: string[][], importId: unknown, userId?: unknown,
 *           fields: { field: string, label: string, group?: string }[] }} input
 * @returns {Promise<{ column: string, field: string }[]>} Only real columns and real fields,
 *          each field once; columns the AI left out or answered null for are not in it
 */
export async function suggestCsvMapping({ headers, sampleRows, fields, importId, userId }) {
  const { output } = await runAiTask({
    task: 'suggestCsvMapping',
    promptVersion: SUGGEST_CSV_MAPPING_VERSION,
    modelClass: 'fast',
    system: SYSTEM,
    user: JSON.stringify({
      columns: headers.map((heading, index) => ({
        heading,
        samples: sampleRows
          .map((row) => row[index])
          .filter(Boolean)
          .slice(0, 3)
          .map(maskSample),
      })),
      fields: fields.map(({ field, label, group }) => ({ key: field, label, group })),
    }),
    schema: csvMappingSchema,
    inputRefs: [{ kind: 'imports', id: importId }],
    userId,
    entityType: 'imports',
    entityId: importId,
  });

  // The model's answer is checked against what really exists.
  const known = new Set(fields.map((item) => item.field));
  const usedFields = new Set();
  const usedColumns = new Set();
  const mapping = [];
  for (const { column, field } of output.mapping) {
    if (!field || !known.has(field) || !headers.includes(column)) continue;
    if (usedFields.has(field) || usedColumns.has(column)) continue;
    usedFields.add(field);
    usedColumns.add(column);
    mapping.push({ column, field });
  }
  // In the order of the file's columns.
  return mapping.sort((a, b) => headers.indexOf(a.column) - headers.indexOf(b.column));
}
