// Decision 0014: the CRM uses ONE company mailbox instead of one Gmail per person. Before this,
// several people may have connected their own. This keeps one of them as the company mailbox:
// the working one with the most mail already in the CRM (ties: the one connected last), so its
// mail is not read in again. The others are moved aside into "user_google_connections_removed"
// (still sealed), so "down" can put them back. Their mail stays in the CRM.
// Rules: it must be safe to run on a database of any size, and "down" must put back what
// "up" changed. Use the plain database driver (db.collection('name')), not the models:
// models change later, a migration must keep working as written.

const REMOVED = 'user_google_connections_removed';

/** @param {import('mongodb').Db} db */
export async function up(db) {
  const connections = db.collection('user_google_connections');
  const all = await connections.find().toArray();
  if (all.length === 0) return;

  const threads = db.collection('email_threads');
  const ranked = [];
  for (const connection of all) {
    ranked.push({
      connection,
      isWorking: connection.status === 'connected' ? 1 : 0,
      mail: await threads.countDocuments({ userId: connection.userId }),
      at: new Date(connection.connectedAt ?? 0).getTime(),
    });
  }
  ranked.sort((a, b) => b.isWorking - a.isWorking || b.mail - a.mail || b.at - a.at);
  const [kept, ...others] = ranked.map((item) => item.connection);

  await connections.updateOne(
    { _id: kept._id },
    { $set: { connectedBy: kept.connectedBy ?? kept.userId } },
  );
  if (others.length > 0) {
    await db
      .collection(REMOVED)
      .insertMany(others.map((connection) => ({ ...connection, removedAt: new Date() })));
    await connections.deleteMany({ _id: { $in: others.map((connection) => connection._id) } });
  }
}

/** @param {import('mongodb').Db} db */
export async function down(db) {
  const removed = db.collection(REMOVED);
  const back = await removed.find().toArray();
  if (back.length > 0) {
    const connections = db.collection('user_google_connections');
    for (const { removedAt, ...connection } of back) {
      void removedAt;
      await connections.updateOne({ _id: connection._id }, { $set: connection }, { upsert: true });
    }
    await removed.deleteMany({});
  }
}
