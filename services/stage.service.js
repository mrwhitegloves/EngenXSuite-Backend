import mongoose from 'mongoose';
import { writeAudit } from '../lib/audit.js';
import { badRequest, conflict } from '../lib/errors.js';
import { Opportunity, StageHistory } from '../models/opportunity.model.js';
import { PipelineStage } from '../models/pipelineStage.model.js';

// THE stage service (Master Prompt Section 12, REQ-OPP-003). A lead has exactly one stage, and
// only the functions in this file write it: `stageId`, `stageEnteredAt`, `status`, `closedAt`,
// `closeReason`, `lostToCompetitor`, and the rows of `stage_history`.
// The pipeline board, the lead page, the edit form, an import: all of them come through here,
// so every stage change leaves the same traces.

const stageProblem = (message, field = 'stageId') => badRequest(message, [{ field, message }]);

/**
 * The stage a new lead starts in: the chosen one, or the first open stage of the pipeline.
 * A lead cannot be created as won or lost.
 * @param {unknown} [stageId]
 */
export async function startingStage(stageId) {
  if (stageId) {
    const stage = await PipelineStage.findOne({ _id: stageId, isActive: true }).lean();
    if (!stage) throw stageProblem('Choose a stage from the list');
    if (stage.type !== 'open') throw stageProblem('A new lead starts in an open stage');
    return stage;
  }
  const first = await PipelineStage.findOne({ isActive: true, type: 'open' })
    .sort({ order: 1, _id: 1 })
    .lean();
  if (!first) throw conflict('The pipeline has no open stage. Add one in Settings first.');
  return first;
}

/**
 * The first row of a lead's stage history. Called by createLead inside its transaction.
 * @param {{ _id: unknown, stageId: unknown, stageEnteredAt: Date }} lead
 */
export async function writeFirstStage(lead, actor, session, via) {
  await StageHistory.create(
    [
      {
        opportunityId: lead._id,
        toStageId: lead.stageId,
        changedBy: actor?._id,
        changedAt: lead.stageEnteredAt,
        via,
      },
    ],
    { session },
  );
}

/**
 * Move a lead to another stage. The caller has already checked that the actor may edit the lead.
 * The lead and its history row are written together or not at all.
 *
 * @param {object} actor
 * @param {object} lead  The saved lead (plain object)
 * @param {{ stageId: string, closeReason?: string | null, lostToCompetitor?: string | null,
 *           via?: string }} data  Already validated
 * @returns {Promise<{ changed: boolean }>}  false when the lead is in that stage already
 */
export async function moveToStage(actor, lead, data, context = {}) {
  if (String(data.stageId) === String(lead.stageId)) return { changed: false };
  const [stage, previous] = await Promise.all([
    PipelineStage.findOne({ _id: data.stageId, isActive: true }).lean(),
    PipelineStage.findById(lead.stageId).lean(),
  ]);
  if (!stage) throw stageProblem('Choose a stage from the list');

  const isClosing = stage.type !== 'open';
  const closeReason = data.closeReason?.trim();
  if (isClosing && !closeReason) {
    throw stageProblem(
      stage.type === 'won' ? 'Say why this lead was won' : 'Say why this lead was lost',
      'closeReason',
    );
  }

  const now = new Date();
  const set = { stageId: stage._id, stageEnteredAt: now, status: stage.type };
  const unset = {};
  // The stage's suggested chance of winning replaces the old one.
  if (stage.defaultProbability !== undefined && stage.defaultProbability !== null) {
    set.probability = stage.defaultProbability;
  }
  if (isClosing) {
    set.closedAt = now;
    set.closeReason = closeReason;
    const competitor = stage.type === 'lost' ? data.lostToCompetitor?.trim() : null;
    if (competitor) set.lostToCompetitor = competitor;
    else unset.lostToCompetitor = '';
  } else {
    // Reopened: it is no longer closed, so it has no closing date or reason.
    Object.assign(unset, { closedAt: '', closeReason: '', lostToCompetitor: '' });
  }

  await mongoose.connection.transaction(async (session) => {
    // Only when the lead is still in the stage we read: two people moving the same card at the
    // same moment must not both win.
    const result = await Opportunity.updateOne(
      { _id: lead._id, stageId: lead.stageId, deletedAt: null },
      { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { session },
    );
    if (result.matchedCount === 0) {
      throw conflict('Someone else just moved this lead. Reload and try again.');
    }
    await StageHistory.create(
      [
        {
          opportunityId: lead._id,
          fromStageId: lead.stageId,
          toStageId: stage._id,
          changedBy: actor?._id,
          changedAt: now,
          msInPreviousStage: now - new Date(lead.stageEnteredAt),
          via: data.via,
        },
      ],
      { session },
    );
  });

  await writeAudit({
    actor,
    action: 'lead.stage_changed',
    entityType: 'opportunities',
    entityId: lead._id,
    oldValue: { stage: previous?.name ?? null },
    newValue: {
      stage: stage.name,
      ...(isClosing ? { closeReason, lostToCompetitor: set.lostToCompetitor ?? null } : {}),
    },
    requestId: context.requestId,
  });
  return { changed: true };
}
