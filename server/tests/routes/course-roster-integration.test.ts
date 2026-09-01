// server/tests/routes/course-roster-integration.test.ts
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { registerLtiLoginRoute } from '../../src/routes/lti-login.js';
import { registerLtiLaunchRoute } from '../../src/routes/lti-launch.js';
import { registerCourseRosterRoutes } from '../../src/routes/course-roster.js';
import { createAllowlist } from '../../src/lti/login.js';
import { findEnabledDeployment } from '../../src/lti/registrations.js';
import { createOidcTransaction } from '../../src/lti/oidc-transactions.js';
import { createRequireSession, createRequireCsrf } from '../../src/auth/middleware.js';
import { JwksCache } from '../../src/lti/jwks-cache.js';
import { loadSigningKeysFromEnv } from '../../src/lti/signing-keys.js';
import { SigningKeyProvider } from '../../src/lti/signing-key-store.js';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndRegistration } from '../support/seed.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';
import { auditEvents } from '../../src/database/schema.js';
import type { Database } from '../../src/database/client.js';

const NRPS_CLAIM = 'https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice';
const APP_BASE_URL = 'https://app.test';
const TARGET = `${APP_BASE_URL}/index.html`;

function buildTestApp(db: Database, jwksCache: JwksCache, signingKeyProvider: SigningKeyProvider) {
  const app = Fastify({ logger: false });
  app.register(fastifyCookie);
  app.register(fastifyFormbody);
  registerLtiLoginRoute(app, {
    appBaseUrl: APP_BASE_URL,
    allowedTargetLinkUris: createAllowlist([TARGET]),
    findEnabledDeployment: (iss, clientId, deploymentId) => findEnabledDeployment(db, iss, clientId, deploymentId),
    createTransaction: (params) => createOidcTransaction(db, { ...params, ttlSeconds: 300 }),
  });
  registerLtiLaunchRoute(app, { db, jwksCache, clockSkewSeconds: 120, sessionTtlHours: 8, appBaseUrl: APP_BASE_URL });
  registerCourseRosterRoutes(app, {
    db,
    requireSession: createRequireSession(db),
    requireCsrf: createRequireCsrf(APP_BASE_URL),
    signingKeyProvider,
  });
  return app;
}

describe('Phase 4 integration: real launch through GET /api/course/roster', () => {
  let platform: MockCanvasPlatform;
  let jwksCache: JwksCache;
  let signingKeyProvider: SigningKeyProvider;

  beforeAll(async () => {
    platform = new MockCanvasPlatform();
    await platform.start();
    signingKeyProvider = new SigningKeyProvider(await loadSigningKeysFromEnv(undefined));
  });
  afterAll(async () => {
    await platform.stop();
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    jwksCache = new JwksCache({ fetchJwks: (uri) => fetch(uri).then((r) => r.json()) });
  });

  it('returns a paginated, normalized roster with no CSV upload after a real instructor launch', async () => {
    const { db } = getTestDb();
    const seeded = await seedInstitutionAndRegistration(db, platform);
    platform.setCourseMembers('integration-course', [
      { user_id: 'lti-u1', status: 'Active', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'], lis_person_sourcedid: '111', name: 'Student One' },
      { user_id: 'lti-u2', status: 'Active', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'], lis_person_sourcedid: '222', name: 'Prof Two' },
    ]);
    platform.setPageSize(1);

    const app = buildTestApp(db, jwksCache, signingKeyProvider);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/lti/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        iss: platform.issuer,
        login_hint: 'lti-u1',
        target_link_uri: TARGET,
        client_id: seeded.clientId,
        lti_deployment_id: seeded.deploymentId,
        lti_message_hint: 'msg-hint-1',
      }).toString(),
    });
    expect(loginRes.statusCode).toBe(302);
    const redirect = new URL(loginRes.headers.location as string);
    const state = redirect.searchParams.get('state')!;
    const nonce = redirect.searchParams.get('nonce')!;

    const idToken = await platform.mintIdToken({
      nonce,
      sub: 'lti-u1',
      deploymentId: seeded.deploymentId,
      contextId: 'integration-course',
      roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'],
      extraClaims: {
        [NRPS_CLAIM]: { context_memberships_url: platform.nrpsUrlFor('integration-course') },
      },
    });

    const launchRes = await app.inject({
      method: 'POST',
      url: '/lti/launch',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ state, id_token: idToken }).toString(),
    });
    expect(launchRes.statusCode).toBe(303);
    const setCookie = Array.isArray(launchRes.headers['set-cookie'])
      ? launchRes.headers['set-cookie'].join(';')
      : String(launchRes.headers['set-cookie']);
    const sessionToken = /attendance_session=([^;]+)/.exec(setCookie)?.[1];
    expect(sessionToken).toBeTruthy();

    const rosterRes = await app.inject({
      method: 'GET',
      url: '/api/course/roster',
      cookies: { attendance_session: sessionToken! },
    });

    expect(rosterRes.statusCode).toBe(200);
    const body = rosterRes.json();
    expect(body.members).toHaveLength(2);
    expect(body.members.some((m: { eligibleForAttendance: boolean }) => m.eligibleForAttendance)).toBe(true);
    expect(body.members.some((m: { eligibleForAttendance: boolean }) => !m.eligibleForAttendance)).toBe(true);

    // The GET-triggered live refresh wrote a roster_refreshed audit row (spec §33).
    const audits = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'roster_refreshed'));
    expect(audits).toHaveLength(1);
    expect(audits[0].requestId).toBeTruthy();
  });
});
