import { MongoMemoryServer } from 'mongodb-memory-server';

// One-time helper: downloads the MongoDB binary used by the in-memory test database (about 740 MB)
// so the first `npm test` does not time out on a slow connection.
// Run once per computer:  node tests/helpers/downloadTestDb.js

const server = await MongoMemoryServer.create();
await server.stop();
process.stdout.write('Test database binary is ready.\n');
