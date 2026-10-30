// The Links screen (founder, 2026-10-30) is the new permission feature "links". The CEO role
// gets every action on it; other roles get it only when the CEO gives it (Settings → Roles),
// because links may hold credentials.
// Rules: safe on any amount of data, "down" undoes "up", plain driver only.

const ACTIONS = ['view', 'create', 'edit', 'delete', 'export', 'assign', 'approve'];

/** @param {import('mongodb').Db} db */
export async function up(db) {
  const roles = db.collection('roles');
  const ceo = await roles.findOne({ name: 'CEO' });
  if (!ceo) return;
  const has = new Set(
    (ceo.grants ?? []).filter((grant) => grant.feature === 'links').map((grant) => grant.action),
  );
  const missing = ACTIONS.filter((action) => !has.has(action)).map((action) => ({
    feature: 'links',
    action,
    scope: 'all',
  }));
  if (missing.length) {
    await roles.updateOne({ _id: ceo._id }, { $push: { grants: { $each: missing } } });
  }
}

/** @param {import('mongodb').Db} db */
export async function down(db) {
  await db.collection('roles').updateMany({}, { $pull: { grants: { feature: 'links' } } });
}
