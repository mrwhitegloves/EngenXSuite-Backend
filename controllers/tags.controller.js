import { createTag, deleteTag, listTags, mergeTags, updateTag } from '../services/tags.service.js';
import { sendCreated, sendOk } from '../lib/respond.js';

// GET /api/tags: every tag (for pickers). ?withUses=true adds how many records carry each.
export async function getTags(req, res) {
  sendOk(res, await listTags({ withUses: req.validated.query.withUses === 'true' }));
}

// POST /api/tags
export async function postTag(req, res) {
  sendCreated(res, await createTag(req.user, req.validated.body, { requestId: req.id }));
}

// PATCH /api/tags/:id: rename, recolour, change where it is offered.
export async function patchTag(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await updateTag(req.user, params.id, body, { requestId: req.id }));
}

// POST /api/tags/:id/merge: move this tag's records to another tag, then delete this one.
export async function postMergeTag(req, res) {
  const { params, body } = req.validated;
  sendOk(res, await mergeTags(req.user, params.id, body.intoTagId, { requestId: req.id }));
}

// DELETE /api/tags/:id: delete the tag and take it off every record.
export async function removeTag(req, res) {
  sendOk(res, await deleteTag(req.user, req.validated.params.id, { requestId: req.id }));
}
