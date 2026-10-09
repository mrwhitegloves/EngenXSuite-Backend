import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Runs before every commit (.husky/pre-commit). It stops a commit that would:
//   1. add a secrets file (.env), or
//   2. add a line that looks like a real secret (database password, cloud key, private key), or
//   3. add code that fails the formatter or the linter.
// A secret that reaches GitHub must be treated as leaked, so it is caught here, before the push.
// To check by hand: node scripts/precommit.js

// What a real secret looks like. Placeholders such as <password> do not match.
export const SECRET_PATTERNS = [
  {
    name: 'a database address with a password',
    pattern: /mongodb(\+srv)?:\/\/[^\s:@/<>]+:[^\s@<>]+@/,
  },
  { name: 'a Redis address with a password', pattern: /rediss?:\/\/[^\s:@/<>]*:[^\s@<>]+@/ },
  { name: 'an AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'a private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'a Google client secret', pattern: /\bGOCSPX-[\w-]{20,}/ },
  { name: 'an OpenRouter key', pattern: /\bsk-or-v1-[0-9a-f]{20,}/ },
  {
    // A filled-in line of an env file, such as SOME_AUTH_TOKEN=abc123… (an empty value is fine).
    name: 'a filled-in token or password setting',
    pattern:
      /^\+\s*(export\s+)?[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)[A-Z0-9_]*=['"]?[^\s'"<>]{16,}/,
  },
];

/** A file that holds real secrets: ".env" and ".env.anything", but not ".env.example". */
export function isSecretsFile(filePath) {
  const name = filePath.split('/').pop();
  return /^\.env(\..+)?$/.test(name) && name !== '.env.example';
}

/**
 * Look for secrets in the lines a commit adds.
 * @param {string} diff  Output of "git diff --cached -U0"
 * @returns {{ file: string, what: string }[]}
 */
export function findSecrets(diff) {
  const found = [];
  let file = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.slice(4).replace(/^b\//, '');
    } else if (line.startsWith('+')) {
      for (const { name, pattern } of SECRET_PATTERNS) {
        if (pattern.test(line)) found.push({ file, what: name });
      }
    }
  }
  return found;
}

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function run() {
  const staged = git('diff', '--cached', '--name-only', '--diff-filter=ACMR')
    .split('\n')
    .filter(Boolean);
  if (staged.length === 0) return 0;
  const problems = [];

  for (const file of staged.filter(isSecretsFile)) {
    problems.push(`${file}: a secrets file must never be committed.`);
  }
  for (const { file, what } of findSecrets(git('diff', '--cached', '-U0'))) {
    problems.push(`${file}: a line looks like ${what}.`);
  }
  if (problems.length > 0) {
    process.stderr.write(
      `\nCommit stopped: possible secret.\n  ${problems.join('\n  ')}\n` +
        'Remove it (git restore --staged <file>). If a real secret was typed into a file, ' +
        'change that secret at the provider as well.\n\n',
    );
    return 1;
  }

  // Format and lint only the files of this commit that still exist.
  const code = staged.filter((file) => /\.(js|jsx|mjs)$/.test(file) && existsSync(file));
  const text = staged.filter(
    (file) => /\.(js|jsx|mjs|json|css|md|html)$/.test(file) && existsSync(file),
  );
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  try {
    if (text.length > 0) {
      execFileSync(npx, ['prettier', '--check', '--ignore-unknown', ...text], {
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });
    }
    if (code.length > 0) {
      execFileSync(npx, ['eslint', ...code], {
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });
    }
  } catch {
    process.stderr.write(
      '\nCommit stopped: fix the problems above (npm run format fixes formatting).\n\n',
    );
    return 1;
  }
  return 0;
}

// Only when started as a script, not when a test imports the functions above.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(run());
}
