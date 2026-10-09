// Test migration: works.
export async function up(db) {
  await db.collection('sample_steps').insertOne({ _id: 'first' });
}

export async function down(db) {
  await db.collection('sample_steps').deleteOne({ _id: 'first' });
}
