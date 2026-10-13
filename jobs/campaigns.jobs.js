import { runCampaignStep, sweepCampaigns } from '../services/campaigns.service.js';

/**
 * One step of a bulk sending: the next person. Safe to run twice: a person is claimed before
 * anything is sent.
 * @param {{ campaignId: string }} data
 */
export async function runCampaignStepJob({ campaignId }) {
  return runCampaignStep(campaignId);
}

/** Every minute: wake sendings whose next step is overdue. */
export async function runCampaignSweepJob() {
  return sweepCampaigns();
}
