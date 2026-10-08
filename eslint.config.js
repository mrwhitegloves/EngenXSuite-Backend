import js from '@eslint/js';
import globals from 'globals';

// Functional code only (decision 0005): our own code may not define classes.
const NO_CLASSES = [
  'error',
  {
    selector: 'ClassDeclaration',
    message: 'No classes: export plain functions instead (decision 0005).',
  },
  {
    selector: 'ClassExpression',
    message: 'No classes: export plain functions instead (decision 0005).',
  },
];

export default [
  { ignores: ['node_modules/**', 'coverage/**', 'public/**'] },
  js.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      'no-restricted-syntax': NO_CLASSES,
      'no-console': 'error', // use the logger, so output is structured and redacted
    },
  },
];
