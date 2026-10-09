import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// The product name is a setting (decision 0001). This check fails when the default name is
// typed into the code anywhere except the few places that hold the first-run default.
// Run by CI and by: npm run check:names

// The places where the default name is allowed to appear.
const ALLOWED = [
  '.env.example',
  'config/env.js',
  'tests/env.test.js',
  'scripts/checkProductName.js',
  'package-lock.json',
];
const NAME = /EngenX\s?Suite/i;
const TEXT_FILE = /\.(js|jsx|mjs|json|html|css|md|yml|yaml|example)$|^Dockerfile$/;

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter((file) => file && TEXT_FILE.test(file) && !ALLOWED.includes(file));

const problems = [];
for (const file of files) {
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      if (NAME.test(line)) problems.push(`${file}:${index + 1}`);
    });
}

if (problems.length > 0) {
  process.stderr.write(
    `The product name is written into the code in:\n  ${problems.join('\n  ')}\n` +
      'Use the branding setting instead: getBranding() on the server, useBranding() in the client.\n',
  );
  process.exit(1);
}
process.stdout.write(`Product name check passed (${files.length} files).\n`);
