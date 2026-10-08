import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
    // Values the server needs to load. Tests never read the real .env file.
    env: {
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/crm_test_placeholder',
    },
  },
});
