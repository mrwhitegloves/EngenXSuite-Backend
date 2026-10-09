import { SavedView } from '../models/savedView.model.js';
import { conflict, notFound } from '../lib/errors.js';

// Saved views: each user's own named filter sets, per screen. A user only ever sees and
// changes their own; another user's view answers "not found".

const MAX_VIEWS_PER_SCREEN = 20;

function toView(view) {
  return { id: String(view._id), screen: view.screen, name: view.name, query: view.query ?? {} };
}

/** The signed-in user's views for one screen, by name. */
export async function listSavedViews(actor, screen) {
  const views = await SavedView.find({ userId: actor._id, screen }).sort({ name: 1 }).lean();
  return views.map(toView);
}

/**
 * Save the current filters under a name. The same name on the same screen is replaced, so
 * "save again" updates a view.
 * @param {object} actor
 * @param {{ screen: string, name: string, query: Record<string, string> }} data
 */
export async function saveView(actor, { screen, name, query }) {
  const existing = await SavedView.findOne({ userId: actor._id, screen, name }).lean();
  if (!existing) {
    const count = await SavedView.countDocuments({ userId: actor._id, screen });
    if (count >= MAX_VIEWS_PER_SCREEN) {
      throw conflict(
        `You can keep ${MAX_VIEWS_PER_SCREEN} saved views per screen. Delete one first.`,
      );
    }
  }
  const view = await SavedView.findOneAndUpdate(
    { userId: actor._id, screen, name },
    { $set: { query } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  return toView(view);
}

export async function deleteSavedView(actor, viewId) {
  const result = await SavedView.deleteOne({ _id: viewId, userId: actor._id });
  if (result.deletedCount === 0) throw notFound('Saved view not found');
}
