import js from '@eslint/js';
import globals from 'globals';
import eslintConfigPrettier from 'eslint-config-prettier';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      // Allow destructuring a property out of an object solely to exclude
      // it from a `...rest` spread (see app.js's parsedReportLogDetail).
      'no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  eslintConfigPrettier,
  {
    ignores: ['dist/', 'node_modules/'],
  },
];
