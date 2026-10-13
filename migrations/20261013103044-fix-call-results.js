// Calls in which the other person picked up were stored as "did not connect" (or missed, busy,
// no answer): the result was worked out from a length that Plivo does not send with that
// callback. This sets them to "completed", with the length Plivo sent at the hang-up, and
// corrects the line on the timeline. The exact length and charge follow from Plivo's own
// record (the job "calls.settle-sweep"). What was there before is kept, so "down" can put it back.
// Rules: it must be safe to run on a database of any size, and "down" must put back what
// "up" changed. Use the plain database driver (db.collection('name')), not the models:
// models change later, a migration must keep working as written.

const clock = (total) => `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** @param {import('mongodb').Db} db */
export async function up(db) {
  const calls = db.collection('calls');
  const activities = db.collection('activities');
  const wrong = calls.find({
    'plivo.dial.DialStatus': 'completed',
    status: { $in: ['failed', 'missed', 'busy', 'no_answer'] },
  });
  for await (const call of wrong) {
    const durationSec =
      number(call.plivo?.dial?.DialBLegDuration) ||
      number(call.plivo?.hangup?.BillDuration) ||
      number(call.plivo?.hangup?.Duration);
    await calls.updateOne(
      { _id: call._id },
      {
        $set: {
          status: 'completed',
          durationSec,
          resultBeforeFix: { status: call.status, durationSec: call.durationSec ?? 0 },
        },
      },
    );
    const entry = await activities.findOne({
      refCollection: 'calls',
      refId: call._id,
      subtype: 'call_ended',
    });
    if (!entry) continue;
    await activities.updateOne(
      { _id: entry._id },
      {
        $set: {
          status: 'completed',
          // "Call to Asha · did not connect" → "Call to Asha · 1:05"
          title: `${String(entry.title).replace(/ · [^·]*$/, '')} · ${clock(durationSec)}`,
          'metadata.durationSec': durationSec,
          'metadata.beforeFix': { title: entry.title, status: entry.status ?? null },
        },
      },
    );
  }
}

/** @param {import('mongodb').Db} db */
export async function down(db) {
  const calls = db.collection('calls');
  const activities = db.collection('activities');
  for await (const call of calls.find({ resultBeforeFix: { $exists: true } })) {
    await calls.updateOne(
      { _id: call._id },
      { $set: call.resultBeforeFix, $unset: { resultBeforeFix: '' } },
    );
  }
  for await (const entry of activities.find({ 'metadata.beforeFix': { $exists: true } })) {
    await activities.updateOne(
      { _id: entry._id },
      {
        $set: { title: entry.metadata.beforeFix.title, status: entry.metadata.beforeFix.status },
        $unset: { 'metadata.beforeFix': '' },
      },
    );
  }
}
