// Test migration: must not run, because the one before it failed.
export async function up(db) {
  await db.collection('sample_steps').insertOne({ _id: 'third' });
}

export async function down(db) {
  await db.collection('sample_steps').deleteOne({ _id: 'third' });
}
