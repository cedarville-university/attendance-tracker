// server/src/index.ts
//
// Composition root for the web process. Loads env, opens the DB pool, gates boot migrations, builds
// the handful of singletons buildApp() needs, then hands off to buildApp(env, deps) and listens.
// All Fastify wiring lives in server/src/app.ts. An unwrapped top-level-await entrypoint, like
// worker.ts.
import { startTelemetry } from './telemetry/otel.js';
// ES imports are hoisted, so this runs before buildApp is *called*, not before the deps modules are
// loaded. That is enough today (startTelemetry only wires the Azure Monitor exporter). If OTel
// auto-instrumentation is ever added, move this into a self-executing ./telemetry/otel-preload.js
// imported as the very first line so it runs before any instrumented module loads.
await startTelemetry();

import { loadEnv } from './config/env.js';
import { createDbClient, applyMigrations } from './database/client.js';
import { loadSigningKeysFromEnv } from './lti/signing-keys.js';
import { createDefaultJwksCache } from './lti/jwks-cache.js';
import { MockIdentityResolver } from './identity/mock-resolver.js';
import { createHttpIdentityResolverFromEnv } from './identity/http-resolver.js';
import { buildApp } from './app.js';

const env = loadEnv();
const dbClient = createDbClient(env.DATABASE_URL);
if (env.RUN_MIGRATIONS_ON_BOOT) {
  await applyMigrations(dbClient);
}

const signingKeys = await loadSigningKeysFromEnv(env.LTI_TOOL_SIGNING_KEYS_JSON);
// Falls back to the Mock resolver whenever the real HTTP resolver's required env vars aren't set
// -- see docs/canvas-lti/progress.md's "Deferred decisions" section for why that's the case.
const identityResolver = createHttpIdentityResolverFromEnv() ?? new MockIdentityResolver();

const app = await buildApp(env, {
  db: dbClient.db,
  signingKeys,
  jwksCache: createDefaultJwksCache(),
  identityResolver,
});

// Task 11: installShutdownHandlers(app, dbClient.pool) goes here.

app.listen({ port: env.PORT, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
