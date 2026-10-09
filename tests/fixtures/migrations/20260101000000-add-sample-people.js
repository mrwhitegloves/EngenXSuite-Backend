// Test migration 1: adds two documents.
export async function up(db) {
  await db.collection('sample_people').insertMany([
    { _id: 1, fullname: 'Asha' },
    { _id: 2, fullname: 'Kunal' },
  ]);
}

export async function down(db) {
  await db.collection('sample_people').deleteMany({ _id: { $in: [1, 2] } });
}
