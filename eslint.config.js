import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default [
  js.configs.recommended,
  {
    files: ['web/**/*.js'],
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
    files: ['web/tests/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // The Playwright webServer launcher is a plain Node ESM script (not TS).
    files: ['e2e/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    // Root-level config files (drizzle.config.ts, vitest.config.ts) are TS too --
    // without this glob `eslint .` lints them with the plain JS parser and chokes.
    files: ['server/**/*.ts', 'e2e/**/*.ts', '*.ts'],
  })),
  {
    files: ['server/**/*.ts', 'e2e/**/*.ts', '*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Allow destructuring a property out of an object solely to exclude it from a
      // `...rest` spread (same reason as the web/**/*.js override above), and allow a
      // leading underscore to mark a deliberately-unused binding or handler parameter.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { ignoreRestSiblings: true, argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  eslintConfigPrettier,
  {
    ignores: ['**/dist/', '**/node_modules/'],
  },
];
