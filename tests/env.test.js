import { describe, expect, it } from 'vitest';
import { parseEnv } from '../config/env.js';

const VALID = { MONGODB_URI: 'mongodb+srv://user:pass@host.example.net/crm_dev' };

describe('environment validation', () => {
  it('fills in defaults for optional values', () => {
    const env = parseEnv(VALID);
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.APP_NAME).toBe('EngenXSuite');
  });

  it('refuses to start without MONGODB_URI and names the variable', () => {
    expect(() => parseEnv({})).toThrow(/MONGODB_URI/);
  });

  it('rejects a malformed MONGODB_URI', () => {
    expect(() => parseEnv({ MONGODB_URI: 'localhost:27017' })).toThrow(/must start with mongodb/);
  });

  it('rejects an invalid port', () => {
    expect(() => parseEnv({ ...VALID, PORT: 'abc' })).toThrow(/PORT/);
  });

  it('never prints the value of a secret in the error message', () => {
    try {
      parseEnv({ MONGODB_URI: 'not-a-uri-with-secret-password' });
    } catch (error) {
      expect(error.message).not.toContain('secret-password');
    }
  });
});
