import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
    // The first run downloads a MongoDB binary for the in-memory test database.
    hookTimeout: 180_000,
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
