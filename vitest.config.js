import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
    // One test file at a time. Each database test file starts its own in-memory MongoDB, and
    // several of those at once run a small computer out of memory ("Failed to open a session").
    fileParallelism: false,
    // The first run downloads a MongoDB binary for the in-memory test database.
    hookTimeout: 180_000,
    // A test that signs in several users and makes a dozen requests can take longer than the
    // default 5 seconds on a small or busy computer; that is slowness, not a failure.
    testTimeout: 30_000,
    // Values the server needs to load. Tests never read the real .env file and never
    // connect to a real database: database tests use an in-memory MongoDB (tests/helpers/testDb.js).
    env: {
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/crm_test_placeholder',
      SESSION_SECRET: 'test-only-session-secret-0123456789-abcdefghij',
      GOOGLE_SIGNIN_CLIENT_ID: 'test-client-id',
      GOOGLE_SIGNIN_CLIENT_SECRET: 'test-client-secret',
      WORKSPACE_DOMAIN: 'engenx.in',
    },
  },
});
