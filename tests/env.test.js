import { describe, expect, it } from 'vitest';
import { parseEnv } from '../config/env.js';

const VALID = {
  MONGODB_URI: 'mongodb+srv://user:pass@host.example.net/crm',
  SESSION_SECRET: 'a-long-random-session-secret-of-40-chars!!',
  GOOGLE_SIGNIN_CLIENT_ID: 'client-id',
  GOOGLE_SIGNIN_CLIENT_SECRET: 'client-secret',
};
const DEV_URI = 'mongodb+srv://user:pass@host.example.net/crm_dev';

describe('environment validation', () => {
  it('fills in defaults for optional values', () => {
    const env = parseEnv(VALID);
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.APP_NAME).toBe('EngenXSuite');
    expect(env.WORKSPACE_DOMAIN).toBe('engenx.in');
  });

  it('refuses to start without MONGODB_URI and names the variable', () => {
    const { MONGODB_URI, ...rest } = VALID;
    expect(MONGODB_URI).toBeDefined();
    expect(() => parseEnv(rest)).toThrow(/MONGODB_URI: is required/);
  });

  it('refuses to start without the login secrets', () => {
    expect(() => parseEnv({ MONGODB_URI: VALID.MONGODB_URI })).toThrow(
      /SESSION_SECRET: is required[\s\S]*GOOGLE_SIGNIN_CLIENT_ID: is required/,
    );
  });

  it('rejects a short session secret', () => {
    expect(() => parseEnv({ ...VALID, SESSION_SECRET: 'short' })).toThrow(/at least 32/);
  });

  it('rejects a malformed MONGODB_URI', () => {
    expect(() => parseEnv({ ...VALID, MONGODB_URI: 'localhost:27017' })).toThrow(
      /must start with mongodb/,
    );
  });

  it('treats blank optional values as not set, so defaults apply', () => {
    const env = parseEnv({ ...VALID, PORT: '', MONGODB_URI_DEV: '', LOG_LEVEL: '' });
    expect(env.PORT).toBe(3000);
    expect(env.MONGODB_URI_DEV).toBeUndefined();
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('rejects an invalid port', () => {
    expect(() => parseEnv({ ...VALID, PORT: 'abc' })).toThrow(/PORT/);
  });

  it('never prints the value of a secret in the error message', () => {
    try {
      parseEnv({ ...VALID, MONGODB_URI: 'not-a-uri-with-secret-password', SESSION_SECRET: 'tiny' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error.message).not.toContain('secret-password');
      expect(error.message).not.toContain('tiny');
    }
  });
});

describe('which database is used', () => {
  it('development uses MONGODB_URI_DEV when it is set', () => {
    const env = parseEnv({ ...VALID, MONGODB_URI_DEV: DEV_URI, NODE_ENV: 'development' });
    expect(env.DATABASE_URI).toBe(DEV_URI);
    expect(env.DATABASE_KIND).toBe('development');
  });

  it('production always uses MONGODB_URI, even when MONGODB_URI_DEV is set', () => {
    const env = parseEnv({ ...VALID, MONGODB_URI_DEV: DEV_URI, NODE_ENV: 'production' });
    expect(env.DATABASE_URI).toBe(VALID.MONGODB_URI);
    expect(env.DATABASE_KIND).toBe('production');
  });

  it('falls back to MONGODB_URI when no development database is configured', () => {
    const env = parseEnv({ ...VALID, NODE_ENV: 'development' });
    expect(env.DATABASE_URI).toBe(VALID.MONGODB_URI);
    expect(env.DATABASE_KIND).toBe('production');
  });
});
