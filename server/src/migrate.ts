// server/src/migrate.ts
//
// Standalone schema-migration entrypoint (spec §39). Applies all pending migrations then exits.
// Run by:
//   - the CI deploy workflow's dedicated `migrate` job (node dist/migrate.js) — spec §39 requires
//     migrations to be a separate deployment step, not a race between app replicas at boot;
//   - `npm run migrate` locally.
// Needs only DATABASE_URL from the environment.

import { loadEnv } from './config/env.js';
import { createDbClient, applyMigrations } from './database/client.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const client = createDbClient(env.DATABASE_URL);
  try {
    await applyMigrations(client);
    // Tally line only — no connection string, no schema detail (spec §31.8).
    console.log('[migrate] all pending migrations applied');
  } finally {
    await client.pool.end();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[migrate] failed', err instanceof Error ? err.message : 'unknown error');
    process.exit(1);
  },
);
