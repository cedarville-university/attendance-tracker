// server/src/worker.ts
//
// The attendance-grade-worker process (spec §35.2). Runs ONE maintenance + grade-sync pass and
// exits — a scheduler (Phase 7) invokes it about every five minutes (spec §35.2 "Five-minute grade
// retry scheduling is sufficient"). Deploys as the same image as the web server with a different
// command. Deliberately NOT wired into the Fastify process (2026-08-28 user ruling).
//
// SIGTERM (Container Apps eviction) sets an abort flag; the maintenance and grade-sync passes check
// it cooperatively (between courses / between purge steps) and return their tally so far, so the
// process exits cleanly without a half-posted course.
//
// Like server/src/index.ts this is an unwrapped top-level-await entrypoint. In deployed environments
// a dedicated CI job runs `node dist/migrate.js`; the worker only migrates at boot when
// `RUN_MIGRATIONS_ON_BOOT` is set (local dev).

import { startTelemetry } from './telemetry/otel.js';
// In deployed envs, Azure Monitor auto-instrumentation is hooked in *before* this module by the
// `node --import ./server/dist/telemetry/otel-preload.js` preload (wired in the Dockerfile CMD and
// the worker-job bicep `command`). This retained call covers the loader-less `tsx` dev path
// (`npm run dev:worker`); under `--import` it is an idempotent no-op, mirroring index.ts.
await startTelemetry();

import { loadEnv } from './config/env.js';
import { createDbClient, applyMigrations } from './database/client.js';
import { loadSigningKeysFromEnv, getActiveSigningKey } from './lti/signing-keys.js';
import { processGradeSyncJobs } from './attendance/grade-worker.js';
import { runMaintenancePass } from './maintenance/purge.js';
import { setGradeJobGauges } from './telemetry/metrics.js';
import { countGradeJobsByState } from './attendance/grade-sync-store.js';

const env = loadEnv();
const dbClient = createDbClient(env.DATABASE_URL);
if (env.RUN_MIGRATIONS_ON_BOOT) {
  await applyMigrations(dbClient);
}
const { db, pool } = dbClient;

let stopRequested = false;
process.on('SIGTERM', () => {
  stopRequested = true;
});
const shouldStop = () => stopRequested;

try {
  const maintenance = await runMaintenancePass(db, { retentionDays: env.RETENTION_DAYS, shouldStop });
  const signingKey = getActiveSigningKey(await loadSigningKeysFromEnv(env.LTI_TOOL_SIGNING_KEYS_JSON));
  const grade = await processGradeSyncJobs(db, { signingKey, shouldStop });
  const gauges = await countGradeJobsByState(db);
  setGradeJobGauges(gauges.pending, gauges.failed);
  // Tally only — no member ids, scores, tokens, or URLs (spec §31.8).
  console.log(`[worker] ${JSON.stringify({ maintenance, grade })}`);
} catch (err) {
  // Server-side log only; never reaches a client. Every Canvas error is captured as an opaque code
  // inside processGradeSyncJobs, so anything caught here is a DB/config fault — log the message only,
  // not the error object, to stay clear of spec §31.8 (no tokens, no service URLs).
  console.error('[worker] pass failed', err instanceof Error ? err.message : 'unknown error');
  await pool.end();
  process.exit(1);
}

await pool.end();
process.exit(0);
