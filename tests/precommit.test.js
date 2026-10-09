import { describe, expect, it } from 'vitest';
import { findSecrets, isSecretsFile } from '../scripts/precommit.js';

// The values below are made up in the shape of real secrets; none of them works anywhere.
// They are put together from pieces, so that this file itself does not look like it holds one.
const FAKE_MONGO = [
  'MONGODB_URI=mongodb+srv://appuser',
  'S3cretPass99@cluster0.ab1cd.example/db',
].join(':');
const FAKE_REDIS = [
  'REDIS_URL=redis://default',
  'Zx81kq02PlmQ@redis-123.cloud.example',
  '6379',
].join(':');
const FAKE_TOKEN = ['PLIVO_AUTH_TOKEN', `Nk3${'a'.repeat(30)}`].join('=');

const diffOf = (file, ...addedLines) =>
  [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, '@@ -0,0 +1 @@']
    .concat(addedLines.map((line) => `+${line}`))
    .join('\n');

describe('pre-commit secret check', () => {
  it('knows which files hold secrets', () => {
    for (const file of ['.env', '.env.local', '.env.production', 'config/.env', 'a/b/.env.dev']) {
      expect(isSecretsFile(file), file).toBe(true);
    }
    for (const file of ['.env.example', 'config/env.js', 'tests/env.test.js', 'README.md']) {
      expect(isSecretsFile(file), file).toBe(false);
    }
  });

  it('finds real-looking secrets in added lines and says which file', () => {
    const fakes = [
      [FAKE_MONGO, 'database'],
      [FAKE_REDIS, 'Redis'],
      [`key: '${'AKIA'}${'ABCDEFGHIJKLMNOP'}'`, 'AWS'],
      [`${'-----BEGIN RSA'} PRIVATE KEY-----`, 'private key'],
      [`secret = '${'GOCSPX'}-abcdefghijklmnopqrstuvwx'`, 'Google'],
      [FAKE_TOKEN, 'token'],
    ];
    for (const [line, what] of fakes) {
      const found = findSecrets(diffOf('notes.txt', line));
      expect(found.length, line.slice(0, 25)).toBeGreaterThan(0);
      expect(found[0].file).toBe('notes.txt');
      expect(found[0].what).toContain(what);
    }
  });

  it('does not complain about placeholders, examples and ordinary code', () => {
    const fine = [
      '# mongodb+srv://<user>:<password>@<cluster-host>/dbname',
      '# redis://default:<password>@<host>:<port>',
      "MONGODB_URI: 'mongodb://127.0.0.1:27017/crm_test_placeholder',",
      'MONGODB_URI=',
      'SESSION_SECRET=',
      'const mongoUri = z.string().regex(/^mongodb(\\+srv)?:\\/\\//);',
      "SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),",
      'const password = req.validated.body.password;',
      'const SESSION_SECRET = createSessionMiddlewareWithAVeryLongName();',
      "export const BRANDING_CACHE_KEY = 'branding';",
    ];
    expect(findSecrets(diffOf('config/env.js', ...fine))).toEqual([]);
  });

  it('looks only at added lines, not at removed or unchanged ones', () => {
    const diff = ['+++ b/file.txt', `-${FAKE_MONGO}`, ` ${FAKE_MONGO}`, '+harmless'].join('\n');
    expect(findSecrets(diff)).toEqual([]);
  });
});
