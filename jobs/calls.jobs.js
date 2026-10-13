import { settleCall, settleWaitingCalls } from '../services/calls.service.js';

/**
 * Read Plivo's own record of a finished call: its exact length and charge. Safe to run twice:
 * a settled call is left alone.
 * @param {{ callId: string }} data
 */
export async function runCallSettleJob({ callId }) {
  return settleCall(callId);
}

/** Every ten minutes: the calls whose record was not ready, or whose job was lost. */
export async function runCallSettleSweepJob() {
  return settleWaitingCalls();
}
