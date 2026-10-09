import { describe, expect, it } from 'vitest';
import { DATE_PRESETS, dateRangeFilter, resolveDateRange } from '../lib/dateRange.js';

// "Now" is Friday 9 October 2026, 10:00 in India (04:30 UTC).
const NOW = new Date('2026-10-09T04:30:00.000Z');
// An India day starts at 18:30 UTC of the day before.
const startOf = (indiaDate) => new Date(`${indiaDate}T00:00:00.000+05:30`);

const rangeOf = (query, now = NOW) => {
  const { from, to } = resolveDateRange(query, now);
  return [from.toISOString(), to.toISOString()];
};
const days = (from, toExclusive) => [
  startOf(from).toISOString(),
  startOf(toExclusive).toISOString(),
];

describe('resolveDateRange', () => {
  it('returns null when no range is asked for', () => {
    expect(resolveDateRange({})).toBeNull();
    expect(resolveDateRange()).toBeNull();
  });

  it('works out every preset with India-time day boundaries', () => {
    expect(rangeOf({ range: 'today' })).toEqual(days('2026-10-09', '2026-10-10'));
    expect(rangeOf({ range: 'yesterday' })).toEqual(days('2026-10-08', '2026-10-09'));
    expect(rangeOf({ range: 'last_7_days' })).toEqual(days('2026-10-03', '2026-10-10'));
    expect(rangeOf({ range: 'last_30_days' })).toEqual(days('2026-09-10', '2026-10-10'));
    expect(rangeOf({ range: 'last_90_days' })).toEqual(days('2026-07-12', '2026-10-10'));
    // Monday to Sunday.
    expect(rangeOf({ range: 'this_week' })).toEqual(days('2026-10-05', '2026-10-12'));
    expect(rangeOf({ range: 'this_month' })).toEqual(days('2026-10-01', '2026-11-01'));
    expect(rangeOf({ range: 'last_month' })).toEqual(days('2026-09-01', '2026-10-01'));
    expect(rangeOf({ range: 'this_quarter' })).toEqual(days('2026-10-01', '2027-01-01'));
    expect(rangeOf({ range: 'last_quarter' })).toEqual(days('2026-07-01', '2026-10-01'));
    // Financial year: April to March.
    expect(rangeOf({ range: 'this_fy' })).toEqual(days('2026-04-01', '2027-04-01'));
    expect(rangeOf({ range: 'last_fy' })).toEqual(days('2025-04-01', '2026-04-01'));
  });

  it('every preset in the list is handled', () => {
    for (const range of DATE_PRESETS.filter((preset) => preset !== 'custom')) {
      const resolved = resolveDateRange({ range }, NOW);
      expect(resolved.from < resolved.to).toBe(true);
      expect(resolved.preset).toBe(range);
    }
  });

  it('uses the India date, not the UTC date, just after midnight in India', () => {
    // 00:30 on 9 October in India is still 8 October in UTC.
    const justAfterMidnight = new Date('2026-10-08T19:00:00.000Z');
    expect(rangeOf({ range: 'today' }, justAfterMidnight)).toEqual(
      days('2026-10-09', '2026-10-10'),
    );
    // 23:30 on 8 October in India.
    const justBeforeMidnight = new Date('2026-10-08T18:00:00.000Z');
    expect(rangeOf({ range: 'today' }, justBeforeMidnight)).toEqual(
      days('2026-10-08', '2026-10-09'),
    );
  });

  it('handles the turn of the year and of the financial year', () => {
    const january = new Date('2026-01-15T06:00:00.000Z');
    expect(rangeOf({ range: 'last_month' }, january)).toEqual(days('2025-12-01', '2026-01-01'));
    expect(rangeOf({ range: 'last_quarter' }, january)).toEqual(days('2025-10-01', '2026-01-01'));
    // January to March belong to the financial year that started the April before.
    expect(rangeOf({ range: 'this_fy' }, january)).toEqual(days('2025-04-01', '2026-04-01'));
    expect(rangeOf({ range: 'last_fy' }, january)).toEqual(days('2024-04-01', '2025-04-01'));
    // A Sunday belongs to the week that started the Monday before.
    const sunday = new Date('2026-10-11T06:00:00.000Z');
    expect(rangeOf({ range: 'this_week' }, sunday)).toEqual(days('2026-10-05', '2026-10-12'));
  });

  it('custom range includes the whole end day', () => {
    expect(rangeOf({ range: 'custom', from: '2026-10-01', to: '2026-10-09' })).toEqual(
      days('2026-10-01', '2026-10-10'),
    );
    // The same day twice is one full day.
    expect(rangeOf({ range: 'custom', from: '2026-10-09', to: '2026-10-09' })).toEqual(
      days('2026-10-09', '2026-10-10'),
    );
    // Something at 23:59 India time on the end day is inside; midnight after it is not.
    const { from, to } = resolveDateRange({
      range: 'custom',
      from: '2026-10-09',
      to: '2026-10-09',
    });
    const lastMinute = new Date('2026-10-09T23:59:00.000+05:30');
    const nextMidnight = new Date('2026-10-10T00:00:00.000+05:30');
    expect(lastMinute >= from && lastMinute < to).toBe(true);
    expect(nextMidnight < to).toBe(false);
  });

  it('rejects wrong ranges with a 400 that names the field', () => {
    const fieldOf = (query) => {
      try {
        resolveDateRange(query, NOW);
        return 'no error';
      } catch (error) {
        expect(error.status).toBe(400);
        return error.details[0].field;
      }
    };
    expect(fieldOf({ range: 'custom', from: '2026-10-09', to: '2026-10-01' })).toBe('from');
    expect(fieldOf({ range: 'custom', from: '2026-10-09' })).toBe('to');
    expect(fieldOf({ range: 'custom', to: '2026-10-09' })).toBe('from');
    expect(fieldOf({ range: 'custom', from: '09-10-2026', to: '2026-10-09' })).toBe('from');
    expect(fieldOf({ range: 'custom', from: '2026-02-31', to: '2026-03-05' })).toBe('from');
    expect(fieldOf({ range: 'custom', from: '2026-10-01', to: '2026-13-01' })).toBe('to');
    expect(fieldOf({ range: 'custom', from: '2015-01-01', to: '2026-10-09' })).toBe('to');
    expect(fieldOf({ range: 'next_century' })).toBe('range');
    expect(fieldOf({ from: '2026-10-01', to: '2026-10-09' })).toBe('range');
  });
});

describe('dateRangeFilter', () => {
  it('builds the database condition, or nothing when there is no range', () => {
    expect(dateRangeFilter('createdAt', null)).toEqual({});
    const resolved = resolveDateRange({ range: 'today' }, NOW);
    expect(dateRangeFilter('createdAt', resolved)).toEqual({
      createdAt: { $gte: resolved.from, $lt: resolved.to },
    });
  });
});
