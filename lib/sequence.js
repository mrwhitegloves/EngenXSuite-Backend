import { Counter } from '../models/counter.model.js';

// Record codes in a running series: EGX-10001, EGX-10002, … for accounts and EGL-10001, … for
// leads. A code is given once, when the record is created, and is never changed or used again
// (a deleted record keeps its code; the series simply goes on).

export const CODE_SERIES = {
  account: { key: 'account', prefix: 'EGX-' },
  lead: { key: 'lead', prefix: 'EGL-' },
};
// The first code of every series ends in 10001.
const FIRST_NUMBER = 10001;

/**
 * Take the next code of a series. Safe when many requests ask at the same moment: the database
 * adds 1 and returns the result in one step.
 * @param {{ key: string, prefix: string }} series  One of CODE_SERIES
 * @returns {Promise<string>} For example "EGX-10001"
 */
export async function nextCode(series) {
  const counter = await Counter.findOneAndUpdate(
    { key: series.key },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  ).lean();
  return `${series.prefix}${FIRST_NUMBER + counter.seq - 1}`;
}
