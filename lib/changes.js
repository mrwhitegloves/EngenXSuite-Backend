// Works out what an edit really changes, for the "update" function of a service.
// Given the saved record and the requested values it answers: which fields differ, what to
// write to the database, and the old and new values for the audit log.
//
// Rules shared by every edit form:
//   - a value equal to what is saved is not a change (so saving a form untouched does nothing)
//   - null means "clear this field" (it is removed from the document)
//   - a small object (an address) is merged: only the parts that are sent change

const asText = (value) =>
  JSON.stringify(value ?? null, (key, item) =>
    // Ids are compared as text: an ObjectId and its string form are the same value.
    item && typeof item === 'object' && item._bsontype === 'ObjectId' ? String(item) : item,
  );

function withoutEmpty(object) {
  const entries = Object.entries(object ?? {}).filter(
    ([, value]) => value !== null && value !== undefined && value !== '',
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/**
 * @param {object} existing   The saved record (plain object)
 * @param {object} requested  The validated request body
 * @param {{ nested?: string[] }} [options]  Fields that are small objects to merge
 * @returns {{ fields: string[], set: object, unset: object, oldValue: object, newValue: object }}
 *          `fields` is empty when nothing changes. `set` / `unset` go into updateOne.
 */
export function planChanges(existing, requested, { nested = [] } = {}) {
  const fields = [];
  const set = {};
  const unset = {};
  const oldValue = {};
  const newValue = {};

  for (const [field, value] of Object.entries(requested)) {
    if (value === undefined) continue;
    const next = nested.includes(field) ? withoutEmpty({ ...existing[field], ...value }) : value;
    if (asText(existing[field]) === asText(next)) continue;

    fields.push(field);
    oldValue[field] = existing[field] ?? null;
    newValue[field] = next ?? null;
    if (next === null) unset[field] = '';
    else set[field] = next;
  }
  return { fields, set, unset, oldValue, newValue };
}

/** The update document for updateOne, or null when there is nothing to write. */
export function toUpdate({ set, unset }) {
  const update = {};
  if (Object.keys(set).length > 0) update.$set = set;
  if (Object.keys(unset).length > 0) update.$unset = unset;
  return Object.keys(update).length > 0 ? update : null;
}
