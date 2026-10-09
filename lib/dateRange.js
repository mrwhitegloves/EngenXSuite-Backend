import { badRequest } from './errors.js';

// The ONE place date ranges are worked out (Master Prompt Section 74). Every list, dashboard and
// report passes its `range`, `from` and `to` query values here; no feature has its own date logic.
//
// Rules: days start and end in India time (UTC+5:30, no daylight saving); the end day is
// included; dates are stored and compared in UTC; the financial year runs April to March;
// a week starts on Monday.

export const DATE_PRESETS = [
  'today',
  'yesterday',
  'last_7_days',
  'last_30_days',
  'last_90_days',
  'this_week',
  'this_month',
  'this_quarter',
  'this_fy',
  'last_month',
  'last_quarter',
  'last_fy',
  'custom',
];

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
// Longest custom range: 5 years. Keeps a mistyped year from scanning everything.
const MAX_CUSTOM_DAYS = 5 * 366;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The calendar date in India at this moment: { year, month (0–11), day, weekday (0 = Sunday) }. */
function indiaDateOf(moment) {
  const shifted = new Date(moment.getTime() + IST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
}

/** The moment an India calendar day starts. Month and day may overflow (day 0, month 12, …). */
function startOfIndiaDay(year, month, day) {
  return new Date(Date.UTC(year, month, day) - IST_OFFSET_MS);
}

function parseDay(text, field) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text ?? '');
  const wanted = match && {
    year: Number(match[1]),
    month: Number(match[2]) - 1,
    day: Number(match[3]),
  };
  // Rejects impossible dates such as 2026-02-31 or month 13, which would silently roll over
  // into the next month or year.
  const real = wanted && indiaDateOf(startOfIndiaDay(wanted.year, wanted.month, wanted.day));
  const isReal =
    real && real.year === wanted.year && real.month === wanted.month && real.day === wanted.day;
  if (!isReal) throw badRequest('Enter the date as YYYY-MM-DD', [{ field }]);
  return wanted;
}

/**
 * Turn the query values into two moments.
 * @param {{ range?: string, from?: string, to?: string }} query
 *        range: one of DATE_PRESETS. For "custom", from and to are India dates "YYYY-MM-DD".
 * @param {Date} [now]  Only tests pass this
 * @returns {{ preset: string, from: Date, to: Date } | null}
 *          from is included, to is NOT included (it is the start of the day after the last day).
 *          null when no range was asked for.
 */
export function resolveDateRange({ range, from, to } = {}, now = new Date()) {
  if (!range) {
    if (from || to) throw badRequest('Choose "Custom range" to use dates', [{ field: 'range' }]);
    return null;
  }
  if (!DATE_PRESETS.includes(range)) throw badRequest('Unknown date range', [{ field: 'range' }]);

  const today = indiaDateOf(now);
  const day = (offset) => startOfIndiaDay(today.year, today.month, today.day + offset);
  const month = (offset) => startOfIndiaDay(today.year, today.month + offset, 1);
  const quarterStartMonth = today.month - (today.month % 3);
  const quarter = (offset) => startOfIndiaDay(today.year, quarterStartMonth + offset * 3, 1);
  // The financial year that contains today started in April of this year or of the last one.
  const fyStartYear = today.month >= 3 ? today.year : today.year - 1;
  const fy = (offset) => startOfIndiaDay(fyStartYear + offset, 3, 1);
  const daysSinceMonday = (today.weekday + 6) % 7;

  const between = (start, end) => ({ preset: range, from: start, to: end });

  switch (range) {
    case 'today':
      return between(day(0), day(1));
    case 'yesterday':
      return between(day(-1), day(0));
    case 'last_7_days':
      return between(day(-6), day(1));
    case 'last_30_days':
      return between(day(-29), day(1));
    case 'last_90_days':
      return between(day(-89), day(1));
    case 'this_week':
      return between(day(-daysSinceMonday), day(7 - daysSinceMonday));
    case 'this_month':
      return between(month(0), month(1));
    case 'last_month':
      return between(month(-1), month(0));
    case 'this_quarter':
      return between(quarter(0), quarter(1));
    case 'last_quarter':
      return between(quarter(-1), quarter(0));
    case 'this_fy':
      return between(fy(0), fy(1));
    case 'last_fy':
      return between(fy(-1), fy(0));
    default: {
      // custom
      if (!from || !to) {
        throw badRequest('Choose a start date and an end date', [{ field: from ? 'to' : 'from' }]);
      }
      const first = parseDay(from, 'from');
      const last = parseDay(to, 'to');
      const start = startOfIndiaDay(first.year, first.month, first.day);
      const end = startOfIndiaDay(last.year, last.month, last.day + 1);
      if (start >= end) {
        throw badRequest('The start date must not be after the end date', [{ field: 'from' }]);
      }
      if ((end - start) / DAY_MS > MAX_CUSTOM_DAYS) {
        throw badRequest('Choose a range of at most 5 years', [{ field: 'to' }]);
      }
      return between(start, end);
    }
  }
}

/**
 * The MongoDB condition for a date field, or {} when there is no range.
 *   const filter = { ...dateRangeFilter('createdAt', resolveDateRange(query)) };
 */
export function dateRangeFilter(field, resolved) {
  if (!resolved) return {};
  return { [field]: { $gte: resolved.from, $lt: resolved.to } };
}
