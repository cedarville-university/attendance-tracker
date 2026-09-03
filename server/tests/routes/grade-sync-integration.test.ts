import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndRegistration } from '../support/seed.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';
import { getActiveSigningKey, loadSigningKeysFromEnv, type ToolSigningKey } from '../../src/lti/signing-keys.js';
import { SigningKeyProvider } from '../../src/lti/signing-key-store.js';
import { createDefaultJwksCache } from '../../src/lti/jwks-cache.js';
import { findEnabledDeployment } from '../../src/lti/registrations.js';
import { createOidcTransaction } from '../../src/lti/oidc-transactions.js';
import { createAllowlist } from '../../src/lti/login.js';
import { registerLtiLoginRoute } from '../../src/routes/lti-login.js';
import { registerLtiLaunchRoute } from '../../src/routes/lti-launch.js';
import { registerAttendanceSessionsRoute } from '../../src/routes/attendance-sessions.js';
import { registerMeRoute } from '../../src/routes/me.js';
import { createRequireSession, createRequireCsrf } from '../../src/auth/middleware.js';
import { MockIdentityResolver } from '../../src/identity/mock-resolver.js';
import { processGradeSyncJobs } from '../../src/attendance/grade-worker.js';
import { gradeSyncJobs, gradeLineItems, auditEvents } from '../../src/database/schema.js';

const NRPS_CLAIM = 'https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice';
const AGS_CLAIM = 'https://purl.imsglobal.org/spec/lti-ags/claim/endpoint';
const APP_BASE_URL = 'http://localhost:3000'; // an origin, no path
const TARGET = `${APP_BASE_URL}/index.html`;
const MOCK_COURSE = 'grade-int-course';

const { db } = getTestDb();
let platform: MockCanvasPlatform;
let signingKey: ToolSigningKey;

beforeAll(async () => {
  platform = new MockCanvasPlatform();
  await platform.start();
  signingKey = getActiveSigningKey(await loadSigningKeysFromEnv(undefined));
});
afterAll(async () => {
  await platform.stop();
  await closeTestDb();
});
beforeEach(async () => {
  await resetDb();
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  await app.register(fastifyFormbody); // POST /lti/login and /lti/launch are form-encoded
  const requireSession = createRequireSession(db);
  const requireCsrf = createRequireCsrf(APP_BASE_URL);
  registerLtiLoginRoute(app, {
    appBaseUrl: APP_BASE_URL,
    allowedTargetLinkUris: createAllowlist([TARGET]),
    findEnabledDeployment: (iss, clientId, deploymentId) => findEnabledDeployment(db, iss, clientId, deploymentId),
    createTransaction: (params) => createOidcTransaction(db, { ...params, ttlSeconds: 300 }),
  });
  registerLtiLaunchRoute(app, {
    db,
    jwksCache: createDefaultJwksCache(),
    clockSkewSeconds: 60,
    sessionTtlHours: 12,
    appBaseUrl: APP_BASE_URL,
  });
  registerMeRoute(app, { requireSession, db }); // the ONLY source of csrfToken (me.ts)
  registerAttendanceSessionsRoute(app, { db, resolver: new MockIdentityResolver(), requireSession, requireCsrf, signingKeyProvider: new SigningKeyProvider([signingKey]) });
  return app;
}

// Extraction of the inline login->launch->cookie plumbing in course-roster-integration.test.ts,
// extended with the /api/me csrfToken fetch that file never needed (its roster GET is read-only).
// registerMeRoute's real deps shape is { requireSession, db } (me.ts) and /api/me returns
// { ..., csrfToken } -- both match this helper.
async function loginAndLaunch(
  app: FastifyInstance,
  mockPlatform: MockCanvasPlatform,
  seeded: { clientId: string; deploymentId: string },
  extraClaims: Record<string, unknown>,
  contextId = MOCK_COURSE,
): Promise<{ cookie: string; csrfToken: string }> {
  const loginRes = await app.inject({
    method: 'POST',
    url: '/lti/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      iss: mockPlatform.issuer,
      login_hint: 'instructor-1',
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

  const idToken = await mockPlatform.mintIdToken({
    nonce,
    sub: 'instructor-1',
    deploymentId: seeded.deploymentId,
    contextId,
    roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'],
    extraClaims,
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
  const cookie = `attendance_session=${sessionToken}`;

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  expect(me.statusCode).toBe(200);
  return { cookie, csrfToken: me.json().csrfToken as string };
}

describe('Phase 6 exit criterion: closing attendance updates the Canvas Gradebook column', () => {
  it('launch -> start -> mark present -> close -> worker -> AGS scores posted to one line item', async () => {
    const seeded = await seedInstitutionAndRegistration(db, platform);
    const app = await buildApp();

    platform.setCourseMembers(MOCK_COURSE, [
      { user_id: 'learner-1', status: 'Active', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'], lis_person_sourcedid: '1000001' },
      { user_id: 'learner-2', status: 'Active', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'], lis_person_sourcedid: '1000002' },
    ]);

    const { cookie, csrfToken } = await loginAndLaunch(app, platform, seeded, {
      [NRPS_CLAIM]: { context_memberships_url: platform.nrpsUrlFor(MOCK_COURSE) },
      [AGS_CLAIM]: { lineitems: platform.lineItemsUrlFor(MOCK_COURSE), scope: [] },
    });
    // Mutating injects need the Origin header too (createRequireCsrf checks it, exact ===).
    const auth = { cookie, 'x-csrf-token': csrfToken, origin: APP_BASE_URL };

    const created = await app.inject({ method: 'POST', url: '/api/attendance-sessions', headers: auth, payload: {} });
    expect(created.statusCode).toBe(201);
    const sessionId = created.json().id;

    // Deterministic present-mark for learner-1 via the manual correction route (no resolver hash).
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/attendance-sessions/${sessionId}/members/learner-1`,
      headers: auth,
      payload: { status: 'present' },
    });
    expect(patched.statusCode).toBe(200);

    const closed = await app.inject({ method: 'POST', url: `/api/attendance-sessions/${sessionId}/close`, headers: auth });
    expect(closed.statusCode).toBe(200);

    // Grades are queued, not yet in Canvas.
    const beforeWorker = await app.inject({ method: 'GET', url: `/api/attendance-sessions/${sessionId}`, headers: auth });
    expect(beforeWorker.json().gradeSync.state).toBe('pending');
    expect(platform.getPostedScores(MOCK_COURSE)).toHaveLength(0);

    // Run the worker.
    const result = await processGradeSyncJobs(db, { signingKey });
    expect(result).toMatchObject({ synced: 2, failed: 0 });

    // One line item, persisted; two scores in Canvas; learner-1 = 100, learner-2 = 0.
    expect(platform.getLineItems(MOCK_COURSE)).toHaveLength(1);
    const [li] = await db.select().from(gradeLineItems);
    expect(li.tag).toBe('attendance');
    const posted = platform.getPostedScores(MOCK_COURSE);
    expect(posted).toHaveLength(2);
    // getPostedScores returns Array<Record<string, unknown>> -- tuple-assert so `new Map` typechecks.
    const byUser = new Map(posted.map((p) => [p.userId as string, p.scoreGiven as number] as const));
    expect(byUser.get('learner-1')).toBe(100);
    expect(byUser.get('learner-2')).toBe(0);

    const afterWorker = await app.inject({ method: 'GET', url: `/api/attendance-sessions/${sessionId}`, headers: auth });
    expect(afterWorker.json().gradeSync).toMatchObject({ state: 'synced', counts: { synced: 2, pending: 0, failed: 0 } });

    expect(await db.select().from(gradeSyncJobs)).toHaveLength(2);
    expect(await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_sync_completed'))).toHaveLength(2);
    expect((await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_sync_requested'))).length).toBeGreaterThanOrEqual(1);
  });
});
