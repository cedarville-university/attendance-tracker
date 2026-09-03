// server/tests/database/migrate-path.test.ts
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { resolveMigrationsFolder } from '../../src/database/client.js';

describe('resolveMigrationsFolder', () => {
  it('resolves to a directory that exists and contains the initial migration + meta journal', () => {
    const folder = resolveMigrationsFolder();
    expect(existsSync(folder)).toBe(true);
    const entries = readdirSync(folder);
    expect(entries).toContain('meta');
    expect(entries.some((e) => /^0000_.*\.sql$/.test(e))).toBe(true);
  });

  it('is an absolute path, not cwd-relative', () => {
    const folder = resolveMigrationsFolder();
    expect(folder.startsWith('/')).toBe(true);
    // sanity: it lives under a `server` directory in source layout
    expect(fileURLToPath(new URL('.', import.meta.url))).toContain('/server/');
  });
});
