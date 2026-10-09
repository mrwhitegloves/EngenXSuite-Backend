import { deleteSavedView, listSavedViews, saveView } from '../services/savedViews.service.js';
import { sendCreated, sendOk } from '../lib/respond.js';

// GET /api/saved-views?screen=users: my saved views for one screen.
export async function getSavedViews(req, res) {
  sendOk(res, await listSavedViews(req.user, req.validated.query.screen));
}

// POST /api/saved-views: save the current filters under a name (the same name is replaced).
export async function postSavedView(req, res) {
  sendCreated(res, await saveView(req.user, req.validated.body));
}

// DELETE /api/saved-views/:id: delete one of my saved views.
export async function removeSavedView(req, res) {
  await deleteSavedView(req.user, req.validated.params.id);
  sendOk(res, { deleted: true });
}
