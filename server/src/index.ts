// server/src/index.ts
//
// Composition root for the web process. Loads env, opens the DB pool, gates boot migrations, builds
// the handful of singletons buildApp() needs, then hands off to buildApp(env, deps) and listens.
// All Fastify wiring lives in server/src/app.ts. An unwrapped top-level-await entrypoint, like
// worker.ts.
import { startTelemetry } from './telemetry/otel.js';
// In deployed envs, Azure Monitor auto-instrumentation is hooked in *before* this module by the
// `node --import ./server/dist/telemetry/otel-preload.js` preload (wired in the Dockerfile CMD and
// the web bicep `command`). This retained call covers the loader-less `tsx` dev path (`npm run
// dev`); under `--import` it is an idempotent no-op (otel.ts's module-level `started` flag is
// already set by the preload).
await startTelemetry();

import { loadEnv } from './config/env.js';
import { createDbClient, applyMigrations } from './database/client.js';
import { loadSigningKeys, SigningKeyProvider } from './lti/signing-key-store.js';
import { createDefaultJwksCache } from './lti/jwks-cache.js';
import { MockIdentityResolver } from './identity/mock-resolver.js';
import { createHttpIdentityResolverFromEnv } from './identity/http-resolver.js';
import { buildApp } from './app.js';
import { installShutdownHandlers } from './lifecycle.js';

const env = loadEnv();
const dbClient = createDbClient(env.DATABASE_URL);
if (env.RUN_MIGRATIONS_ON_BOOT) {
  await applyMigrations(dbClient);
}

const signingKeyProvider = new SigningKeyProvider(
  await loadSigningKeys(dbClient.db, env.LTI_TOOL_SIGNING_KEYS_JSON),
);
// Falls back to the Mock resolver whenever the real HTTP resolver's required env vars aren't set
// -- see docs/canvas-lti/progress.md's "Deferred decisions" section for why that's the case.
const identityResolver = createHttpIdentityResolverFromEnv() ?? new MockIdentityResolver();

const app = await buildApp(env, {
  db: dbClient.db,
  signingKeyProvider,
  jwksCache: createDefaultJwksCache(),
  identityResolver,
});

installShutdownHandlers(app, dbClient.pool);

app.listen({ port: env.PORT, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
