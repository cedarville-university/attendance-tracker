// server/tests/auth/csrf-middleware.test.ts
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import { beforeEach, afterAll, describe, it, expect } from 'vitest';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { institutions, ltiRegistrations, ltiDeployments, courses } from '../../src/database/schema.js';
import { createSession } from '../../src/auth/session.js';
import { createRequireSession, createRequireCsrf } from '../../src/auth/middleware.js';
import { SESSION_COOKIE_NAME } from '../../src/auth/cookies.js';
import { verifyCsrfToken, verifyOrigin, isRejectedMutationContentType } from '../../src/auth/csrf.js';
import type { Database } from '../../src/database/client.js';

async function seedSessionCourse() {
  const { db } = getTestDb();
  const [institution] = await db
    .insert(institutions)
    .values({ slug: 'csrf-test', displayName: 'CSRF Test', timezone: 'UTC', enabled: true })
    .returning();
  const [registration] = await db
    .insert(ltiRegistrations)
    .values({
      institutionId: institution.id,
      issuer: 'https://csrf.test',
      clientId: 'csrf-client',
      oidcAuthEndpoint: 'https://csrf.test/a',
      tokenEndpoint: 'https://csrf.test/t',
      tokenAudience: 'https://csrf.test/t',
      platformJwksUri: 'https://csrf.test/jwks',
      enabled: true,
    })
    .returning();
  const [deployment] = await db
    .insert(ltiDeployments)
    .values({ registrationId: registration.id, deploymentId: 'csrf-deploy', enabled: true, configuration: {} })
    .returning();
  const [course] = await db
    .insert(courses)
    .values({ institutionId: institution.id, deploymentId: deployment.id, ltiContextId: 'csrf-course' })
    .returning();
  return { institutionId: institution.id, deploymentRowId: deployment.id, courseId: course.id };
}

function buildTestApp(db: Database) {
  const app = Fastify({ logger: false });
  app.register(fastifyCookie);
  // Registered here for the same reason it is registered app-wide in index.ts: POST /lti/launch
  // needs to parse Canvas's `form_post` response. Its presence is exactly why requireCsrf must
  // reject form-encoded bodies itself (spec §15) -- without formbody, Fastify would 415 before the
  // preHandler ever ran and the content-type test below would prove nothing.
  app.register(fastifyFormbody);
  const requireSession = createRequireSession(db);
  const requireCsrf = createRequireCsrf('https://app.test');
  app.get('/protected', { preHandler: requireSession }, async () => ({ ok: true }));
  app.post('/mutate', { preHandler: [requireSession, requireCsrf] }, async () => ({ ok: true }));
  return app;
}

// File scope so the shared module-level pg pool in db.ts is closed exactly once, after every
// describe in this file has finished (see the same note in registrations.test.ts).
afterAll(async () => {
  await closeTestDb();
});

describe('requireSession', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns 401 with no session cookie', async () => {
    const app = buildTestApp(getTestDb().db);
    const response = await app.inject({ method: 'GET', url: '/protected' });
    expect(response.statusCode).toBe(401);
  });

  it('returns 401 for an invalid session cookie', async () => {
    const app = buildTestApp(getTestDb().db);
    const response = await app.inject({ method: 'GET', url: '/protected', cookies: { [SESSION_COOKIE_NAME]: 'bogus' } });
    expect(response.statusCode).toBe(401);
  });

  it('allows the request through with a valid session cookie', async () => {
    const { db } = getTestDb();
    const { institutionId, deploymentRowId, courseId } = await seedSessionCourse();
    const created = await createSession(db, {
      institutionId,
      deploymentId: deploymentRowId,
      ltiSubject: 'user-1',
      displayName: null,
      courseId,
      roles: ['Instructor'],
      ttlHours: 8,
    });
    const app = buildTestApp(db);

    const response = await app.inject({ method: 'GET', url: '/protected', cookies: { [SESSION_COOKIE_NAME]: created.token } });

    expect(response.statusCode).toBe(200);
  });
});

describe('requireCsrf', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns 403 when the Origin header does not match', async () => {
    const { db } = getTestDb();
    const { institutionId, deploymentRowId, courseId } = await seedSessionCourse();
    const created = await createSession(db, {
      institutionId,
      deploymentId: deploymentRowId,
      ltiSubject: 'user-1',
      displayName: null,
      courseId,
      roles: ['Instructor'],
      ttlHours: 8,
    });
    const app = buildTestApp(db);

    const response = await app.inject({
      method: 'POST',
      url: '/mutate',
      cookies: { [SESSION_COOKIE_NAME]: created.token },
      headers: { origin: 'https://evil.test', 'x-csrf-token': created.csrfSecret },
    });

    expect(response.statusCode).toBe(403);
  });

  it('returns 403 when the CSRF token does not match', async () => {
    const { db } = getTestDb();
    const { institutionId, deploymentRowId, courseId } = await seedSessionCourse();
    const created = await createSession(db, {
      institutionId,
      deploymentId: deploymentRowId,
      ltiSubject: 'user-1',
      displayName: null,
      courseId,
      roles: ['Instructor'],
      ttlHours: 8,
    });
    const app = buildTestApp(db);

    const response = await app.inject({
      method: 'POST',
      url: '/mutate',
      cookies: { [SESSION_COOKIE_NAME]: created.token },
      headers: { origin: 'https://app.test', 'x-csrf-token': 'wrong-token' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('succeeds when Origin and CSRF token both match', async () => {
    const { db } = getTestDb();
    const { institutionId, deploymentRowId, courseId } = await seedSessionCourse();
    const created = await createSession(db, {
      institutionId,
      deploymentId: deploymentRowId,
      ltiSubject: 'user-1',
      displayName: null,
      courseId,
      roles: ['Instructor'],
      ttlHours: 8,
    });
    const app = buildTestApp(db);

    const response = await app.inject({
      method: 'POST',
      url: '/mutate',
      cookies: { [SESSION_COOKIE_NAME]: created.token },
      headers: { origin: 'https://app.test', 'x-csrf-token': created.csrfSecret },
    });

    expect(response.statusCode).toBe(200);
  });

  it('spec §15: returns 403 for a form-encoded mutation even when Origin and CSRF token are both correct', async () => {
    const { db } = getTestDb();
    const { institutionId, deploymentRowId, courseId } = await seedSessionCourse();
    const created = await createSession(db, {
      institutionId,
      deploymentId: deploymentRowId,
      ltiSubject: 'user-1',
      displayName: null,
      courseId,
      roles: ['Instructor'],
      ttlHours: 8,
    });
    const app = buildTestApp(db);

    const response = await app.inject({
      method: 'POST',
      url: '/mutate',
      cookies: { [SESSION_COOKIE_NAME]: created.token },
      headers: {
        origin: 'https://app.test',
        'x-csrf-token': created.csrfSecret,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({ anything: '1' }).toString(),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'form_encoded_mutation_rejected' });
  });
});

describe('verifyCsrfToken / verifyOrigin / isRejectedMutationContentType (unit)', () => {
  it('rejects when no token is provided', () => {
    expect(verifyCsrfToken('secret', undefined)).toBe(false);
  });

  it('rejects a same-length but different token', () => {
    expect(verifyCsrfToken('secret-a', 'secret-b')).toBe(false);
  });

  it('verifyOrigin requires an exact match', () => {
    expect(verifyOrigin('https://app.test', 'https://app.test')).toBe(true);
    expect(verifyOrigin('https://app.test', 'https://app.test.evil.com')).toBe(false);
    expect(verifyOrigin('https://app.test', undefined)).toBe(false);
  });

  it('isRejectedMutationContentType flags form encodings, ignoring parameters and case, and allows JSON', () => {
    expect(isRejectedMutationContentType('application/x-www-form-urlencoded')).toBe(true);
    expect(isRejectedMutationContentType('Application/X-WWW-Form-Urlencoded; charset=UTF-8')).toBe(true);
    expect(isRejectedMutationContentType('multipart/form-data; boundary=----abc')).toBe(true);
    expect(isRejectedMutationContentType('application/json')).toBe(false);
    expect(isRejectedMutationContentType(undefined)).toBe(false);
  });
});
