// Test migration: fails on purpose.
export async function up() {
  throw new Error('this migration is broken');
}

export async function down() {}
