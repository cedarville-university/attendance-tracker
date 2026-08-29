// server/src/app.ts
//
// buildApp(env, deps) assembles the whole Fastify instance — helmet/CSP, the Permissions-Policy
// hook, request telemetry, cookie/formbody/static, the health probes, the encapsulated rate-limit
// scope for /lti/login + /lti/launch, and the /lti/jwks + /api/* routes. Lifted verbatim (same
// middleware order, same route registrations) from what server/src/index.ts wired inline through
// Phase 6, now parameterised by `deps` so tests and the composition root supply the same handful of
// singletons. Does NOT call app.listen — that stays in the composition root (index.ts).
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import type { Env } from './config/env.js';
import { parseAllowedTargetLinkUris } from './config/env.js';
import type { Database } from './database/client.js';
import { ltiRegistrations } from './database/schema.js';
import type { ToolSigningKey } from './lti/signing-keys.js';
import { getActiveSigningKey } from './lti/signing-keys.js';
import type { JwksCache } from './lti/jwks-cache.js';
import type { IdentityResolver } from './identity/types.js';
import { createAllowlist } from './lti/login.js';
import { findEnabledDeployment } from './lti/registrations.js';
import { createOidcTransaction } from './lti/oidc-transactions.js';
import { registerLtiJwksRoute } from './routes/lti-jwks.js';
import { registerLtiLoginRoute } from './routes/lti-login.js';
import { registerLtiLaunchRoute } from './routes/lti-launch.js';
import { registerMeRoute } from './routes/me.js';
import { registerCourseRosterRoutes } from './routes/course-roster.js';
import { registerAttendanceSessionsRoute } from './routes/attendance-sessions.js';
import { createRequireSession, createRequireCsrf } from './auth/middleware.js';
import { buildCspDirectives } from './security/csp.js';
import { loggerOptions } from './telemetry/logger.js';
import { genReqId, registerRequestTelemetry } from './telemetry/request-id.js';
import { registerHealthRoutes } from './routes/health.js';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');

export interface AppDeps {
  db: Database;
  signingKeys: ToolSigningKey[];
  jwksCache: JwksCache;
  identityResolver: IdentityResolver;
}

// Spec §31.3's form-action directive wants the *configured Canvas OIDC destinations*, and spec §11
// forbids deriving a Canvas endpoint from a hostname -- so read them from lti_registrations, which
// is where the real, discovery-sourced endpoints live. Read once at boot; a newly seeded
// registration needs a restart, which is already true of every other boot-time config here.
async function resolveCanvasOidcOrigins(db: Database): Promise<string[]> {
  const rows = await db
    .select({ id: ltiRegistrations.id, issuer: ltiRegistrations.issuer, oidcAuthEndpoint: ltiRegistrations.oidcAuthEndpoint })
    .from(ltiRegistrations)
    .where(eq(ltiRegistrations.enabled, true));
  return [
    ...new Set(
      rows.map((row) => {
        try {
          return new URL(row.oidcAuthEndpoint).origin;
        } catch {
          throw new Error(
            `lti_registrations row ${row.id} (issuer ${row.issuer}) has a malformed oidc_auth_endpoint: ${JSON.stringify(row.oidcAuthEndpoint)}`,
          );
        }
      }),
    ),
  ];
}

export async function buildApp(env: Env, deps: AppDeps): Promise<FastifyInstance> {
  const { db, signingKeys, jwksCache, identityResolver } = deps;
  const canvasOidcOrigins = await resolveCanvasOidcOrigins(db);
  const allowedTargetLinkUris = createAllowlist(parseAllowedTargetLinkUris(env));

  const app = Fastify({ logger: loggerOptions(env), genReqId });

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: { directives: buildCspDirectives(env.APP_BASE_URL, canvasOidcOrigins) },
  });

  // Spec §31.2. Helmet does not set Permissions-Policy, and this app is a WebHID card scanner: the
  // scanner page needs `hid`, and nothing embedded should get it.
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Permissions-Policy', 'hid=(self)');
  });

  registerRequestTelemetry(app);

  await app.register(fastifyCookie);
  await app.register(fastifyFormbody);
  await app.register(fastifyStatic, { root: webRoot });

  registerHealthRoutes(app, { db });

  // /lti/login and /lti/launch get rate-limited (spec §31.10: 30 req/min/IP) inside their own
  // encapsulated plugin context so the limit doesn't apply to POST
  // /api/attendance-sessions/{id}/scans (classroom bursts, spec §31.10).
  await app.register(async (instance) => {
    await instance.register(fastifyRateLimit, { max: 30, timeWindow: '1 minute' });

    registerLtiLoginRoute(instance, {
      appBaseUrl: env.APP_BASE_URL,
      allowedTargetLinkUris,
      findEnabledDeployment: (iss, clientId, deploymentId) => findEnabledDeployment(db, iss, clientId, deploymentId),
      createTransaction: (params) =>
        createOidcTransaction(db, { ...params, ttlSeconds: env.LOGIN_TRANSACTION_TTL_SECONDS }),
    });

    registerLtiLaunchRoute(instance, {
      db,
      jwksCache,
      clockSkewSeconds: env.CLOCK_SKEW_SECONDS,
      sessionTtlHours: env.APP_SESSION_TTL_HOURS,
      appBaseUrl: env.APP_BASE_URL,
    });
  });

  registerLtiJwksRoute(app, signingKeys);

  const requireSession = createRequireSession(db);
  const requireCsrf = createRequireCsrf(env.APP_BASE_URL);
  registerMeRoute(app, { requireSession, db });
  registerCourseRosterRoutes(app, {
    db,
    requireSession,
    requireCsrf,
    signingKey: getActiveSigningKey(signingKeys),
  });
  registerAttendanceSessionsRoute(app, {
    db,
    resolver: identityResolver,
    requireSession,
    requireCsrf,
    signingKey: getActiveSigningKey(signingKeys),
  });

  return app;
}
