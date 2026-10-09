import { dateRangeFilter, resolveDateRange } from './dateRange.js';

// The ONE helper every list endpoint uses to turn validated query values into a database query
// (Master Prompt Section 74): filters, search, date range, sorting and pages.
// Filtering, sorting and paging always happen in the database, never in the browser.
//
// A list service looks like this:
//   const filter = buildFilter({
//     scope: scopeFilter(actor, 'accounts'),          // what this user may see, always first
//     equals: { status, ownerId },                    // exact-match filters; empty ones are skipped
//     search: { text: search, fields: ['name', 'city'] },
//     dates: { field: 'createdAt', query: { range, from, to } },
//   });
//   return runListQuery(Account, { filter, sort: buildSort(sort, SORTS, '-createdAt'), page, pageSize });

/** Text typed by a user as a safe "contains, any letter case" pattern: it is matched literally. */
export function containsPattern(text) {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

const isEmpty = (value) =>
  value === undefined || value === '' || (Array.isArray(value) && value.length === 0);

/**
 * Combine the parts of a filter with AND.
 * @param {{
 *   scope?: object,                                  the permission filter; never skipped
 *   equals?: Record<string, unknown>,                field → value, or an array for "any of"
 *   search?: { text?: string, fields: string[] },    text contained in any of the fields
 *   dates?: { field: string, query: { range?: string, from?: string, to?: string } },
 *   extra?: object[],                                any further conditions
 * }} parts
 * @returns {object} A MongoDB filter
 */
export function buildFilter({ scope, equals = {}, search, dates, extra = [] } = {}) {
  const conditions = [];
  if (scope && Object.keys(scope).length > 0) conditions.push(scope);

  for (const [field, value] of Object.entries(equals)) {
    if (isEmpty(value)) continue;
    conditions.push({ [field]: Array.isArray(value) ? { $in: value } : value });
  }

  const text = search?.text?.trim();
  if (text) {
    const pattern = containsPattern(text);
    conditions.push({ $or: search.fields.map((field) => ({ [field]: pattern })) });
  }

  if (dates) {
    const range = dateRangeFilter(dates.field, resolveDateRange(dates.query));
    if (Object.keys(range).length > 0) conditions.push(range);
  }

  conditions.push(...extra.filter((condition) => condition && Object.keys(condition).length > 0));

  if (conditions.length === 0) return {};
  return conditions.length === 1 ? conditions[0] : { $and: conditions };
}

/**
 * Turn "name" or "-name" (a leading minus means newest/largest first) into a database sort.
 * Only fields in `allowed` can be sorted on; anything else falls back to the default.
 * `_id` is always added last, so rows with equal values keep one fixed order across pages.
 *
 * @param {string | undefined} sortParam           from the request, e.g. "-lastLoginAt"
 * @param {Record<string, string>} allowed        public name → database field
 * @param {string} defaultSort                    e.g. "name" or "-createdAt"
 */
export function buildSort(sortParam, allowed, defaultSort) {
  const parse = (text) => {
    const descending = text.startsWith('-');
    const field = allowed[descending ? text.slice(1) : text];
    return field ? { [field]: descending ? -1 : 1 } : null;
  };
  const chosen = (sortParam && parse(sortParam)) || parse(defaultSort);
  if (!chosen) throw new Error(`The default sort "${defaultSort}" is not in the allowed list`);
  return { ...chosen, ...(Object.keys(chosen)[0] === '_id' ? {} : { _id: 1 }) };
}

/**
 * Run a list query: one page of rows plus the total for the pager.
 * @returns {Promise<{ rows: object[], pagination: { page: number, pageSize: number, total: number } }>}
 */
export async function runListQuery(model, { filter, sort, page, pageSize, select }) {
  const query = model
    .find(filter)
    .sort(sort)
    .skip((page - 1) * pageSize)
    .limit(pageSize);
  if (select) query.select(select);
  const [rows, total] = await Promise.all([query.lean(), model.countDocuments(filter)]);
  return { rows, pagination: { page, pageSize, total } };
}
