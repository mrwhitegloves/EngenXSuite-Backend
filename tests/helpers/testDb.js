import mongoose from 'mongoose';
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server';

// A real MongoDB that lives in memory for the duration of one test file.
// Tests use the real models and services against it; nothing is mocked and no real database is touched.

let memoryServer;

async function connect(server) {
  memoryServer = server;
  await mongoose.connect(memoryServer.getUri(), { dbName: 'crm_test' });
  // Build the indexes (for example unique email) before tests rely on them.
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}

export async function startTestDb() {
  await connect(await MongoMemoryServer.create());
}

/**
 * The same, started as a one-member replica set, which MongoDB needs for transactions (as on
 * Atlas). It starts a little slower, so only test files whose code uses
 * `mongoose.connection.transaction()` use this one.
 */
export async function startTestDbWithTransactions() {
  await connect(await MongoMemoryReplSet.create({ replSet: { count: 1 } }));
}

export async function clearTestDb() {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
}

export async function stopTestDb() {
  await mongoose.disconnect();
  await memoryServer?.stop();
}
