// server/src/worker.ts
//
// The attendance-grade-worker process (spec §35.2). Runs ONE grade-sync pass and exits — a
// scheduler (Phase 7) invokes it about every five minutes (spec §35.2 "Five-minute grade retry
// scheduling is sufficient"). Deploys as the same image as the web server with a different command.
// Deliberately NOT wired into the Fastify process (2026-08-28 user ruling).
//
// Like server/src/index.ts this is an unwrapped top-level-await entrypoint. In deployed environments
// a dedicated CI job runs `node dist/migrate.js`; the worker only migrates at boot when
// `RUN_MIGRATIONS_ON_BOOT` is set (local dev). No automated test — the
// testable `runWorkerOnce()` extraction is whole-branch follow-up #8 (Phase 7); all worker logic is
// covered by Task 9's suite and Task 13's integration test.

import { loadEnv } from './config/env.js';
import { createDbClient, applyMigrations } from './database/client.js';
import { loadSigningKeysFromEnv, getActiveSigningKey } from './lti/signing-keys.js';
import { processGradeSyncJobs } from './attendance/grade-worker.js';

const env = loadEnv();
const dbClient = createDbClient(env.DATABASE_URL);
if (env.RUN_MIGRATIONS_ON_BOOT) {
  await applyMigrations(dbClient);
}
const { db, pool } = dbClient;

const signingKey = getActiveSigningKey(await loadSigningKeysFromEnv(env.LTI_TOOL_SIGNING_KEYS_JSON));

try {
  const result = await processGradeSyncJobs(db, { signingKey });
  // Tally only — no member ids, scores, tokens, or URLs (spec §31.8).
  console.log(`[grade-worker] ${JSON.stringify(result)}`);
} catch (err) {
  // Server-side log only; never reaches a client. Every Canvas error is captured as an opaque code
  // inside processGradeSyncJobs, so anything caught here is a DB/config fault — log the message only,
  // not the error object, to stay clear of spec §31.8 (no tokens, no service URLs).
  console.error('[grade-worker] pass failed', err instanceof Error ? err.message : 'unknown error');
  await pool.end();
  process.exit(1);
}

await pool.end();
process.exit(0);
