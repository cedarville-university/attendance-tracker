// server/src/index.ts
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import { MockIdentityResolver } from './identity/mock-resolver.js';
import { createHttpIdentityResolverFromEnv } from './identity/http-resolver.js';
import { loadEnv, parseAllowedTargetLinkUris } from './config/env.js';
import { createDbClient, applyMigrations } from './database/client.js';
import { ltiRegistrations } from './database/schema.js';
import { loadSigningKeysFromEnv, getActiveSigningKey } from './lti/signing-keys.js';
import { createDefaultJwksCache } from './lti/jwks-cache.js';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '../../web');

const env = loadEnv();
const dbClient = createDbClient(env.DATABASE_URL);
await applyMigrations(dbClient);
const { db } = dbClient;

const signingKeys = await loadSigningKeysFromEnv(env.LTI_TOOL_SIGNING_KEYS_JSON);
const jwksCache = createDefaultJwksCache();
const allowedTargetLinkUris = createAllowlist(parseAllowedTargetLinkUris(env));

// Spec §31.3's form-action directive wants the *configured Canvas OIDC destinations*, and spec §11
// forbids deriving a Canvas endpoint from a hostname -- so read them from lti_registrations, which
// is where the real, discovery-sourced endpoints live. Read once at boot; a newly seeded
// registration needs a restart, which is already true of every other boot-time config here.
const registrationRows = await db
  .select({ oidcAuthEndpoint: ltiRegistrations.oidcAuthEndpoint })
  .from(ltiRegistrations)
  .where(eq(ltiRegistrations.enabled, true));
const canvasOidcOrigins = [...new Set(registrationRows.map((row) => new URL(row.oidcAuthEndpoint).origin))];

const cspDirectives: Record<string, string[] | null> = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'"],
  connectSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'none'"],
  // 'self' already covers APP_BASE_URL; the extra entries are the Canvas authorization endpoints
  // /lti/login redirects the browser to and that form-POST the launch back to /lti/launch.
  formAction: ["'self'", ...canvasOidcOrigins],
  frameAncestors: ["'none'"],
};
if (!env.APP_BASE_URL.startsWith('https://')) {
  // Helmet's default CSP adds `upgrade-insecure-requests`, which rewrites every
  // http://localhost:3000 request to https:// and breaks local HTTP dev. `null` removes one of
  // helmet's own defaults.
  cspDirectives.upgradeInsecureRequests = null;
}

const app = Fastify({ logger: true });

await app.register(fastifyHelmet, {
  contentSecurityPolicy: { directives: cspDirectives },
});

// Spec §31.2. Helmet does not set Permissions-Policy, and this app is a WebHID card scanner: the
// scanner page needs `hid`, and nothing embedded should get it. Mirrored by
// server/tests/routes/hardening.test.ts.
app.addHook('onRequest', async (_request, reply) => {
  reply.header('Permissions-Policy', 'hid=(self)');
});

await app.register(fastifyCookie);
await app.register(fastifyFormbody);
await app.register(fastifyStatic, { root: webRoot });

// /lti/login and /lti/launch get rate-limited (spec §31.10: 30 req/min/IP) inside their own
// encapsulated plugin context so the limit doesn't apply to POST /api/attendance-sessions/{id}/scans
// (classroom bursts, spec §31.10).
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

// Falls back to the Mock resolver whenever the real HTTP resolver's required env vars aren't set
// -- see docs/canvas-lti/progress.md's "Deferred decisions" section for why that's the case.
const identityResolver = createHttpIdentityResolverFromEnv() ?? new MockIdentityResolver();

registerAttendanceSessionsRoute(app, {
  db,
  resolver: identityResolver,
  requireSession,
  requireCsrf,
  signingKey: getActiveSigningKey(signingKeys),
});

app.get('/health', async () => ({ status: 'ok' }));

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
