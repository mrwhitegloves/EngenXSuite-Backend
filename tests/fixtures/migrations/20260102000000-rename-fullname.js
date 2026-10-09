// Test migration 2: renames a field. Depends on migration 1 having run first.
export async function up(db) {
  await db.collection('sample_people').updateMany({}, { $rename: { fullname: 'name' } });
}

export async function down(db) {
  await db.collection('sample_people').updateMany({}, { $rename: { name: 'fullname' } });
}
