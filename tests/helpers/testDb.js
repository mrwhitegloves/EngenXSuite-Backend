import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// A real MongoDB that lives in memory for the duration of one test file.
// Tests use the real models and services against it; nothing is mocked and no real database is touched.

let memoryServer;

export async function startTestDb() {
  memoryServer = await MongoMemoryServer.create();
  await mongoose.connect(memoryServer.getUri(), { dbName: 'crm_test' });
  // Build the indexes (for example unique email) before tests rely on them.
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}

export async function clearTestDb() {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
}

export async function stopTestDb() {
  await mongoose.disconnect();
  await memoryServer?.stop();
}
