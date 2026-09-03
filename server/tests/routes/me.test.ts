// server/tests/routes/me.test.ts
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { beforeEach, afterAll, describe, it, expect } from 'vitest';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { institutions, ltiRegistrations, ltiDeployments, courses } from '../../src/database/schema.js';
import { createSession } from '../../src/auth/session.js';
import { createRequireSession } from '../../src/auth/middleware.js';
import { SESSION_COOKIE_NAME } from '../../src/auth/cookies.js';
import { registerMeRoute } from '../../src/routes/me.js';
import type { Database } from '../../src/database/client.js';

async function seedFullContext() {
  const { db } = getTestDb();
  const [institution] = await db
    .insert(institutions)
    .values({ slug: 'me-test', displayName: 'Me Test University', timezone: 'UTC', enabled: true })
    .returning();
  const [registration] = await db
    .insert(ltiRegistrations)
    .values({
      institutionId: institution.id,
      issuer: 'https://me.test',
      clientId: 'me-client',
      oidcAuthEndpoint: 'https://me.test/secret-auth-endpoint',
      tokenEndpoint: 'https://me.test/secret-token-endpoint',
      tokenAudience: 'https://me.test/secret-token-endpoint',
      platformJwksUri: 'https://me.test/secret-jwks',
      enabled: true,
    })
    .returning();
  const [deployment] = await db
    .insert(ltiDeployments)
    .values({ registrationId: registration.id, deploymentId: 'me-deploy', enabled: true, configuration: {} })
    .returning();
  const [course] = await db
    .insert(courses)
    .values({ institutionId: institution.id, deploymentId: deployment.id, ltiContextId: 'me-course', label: 'ME101', title: 'Me Course' })
    .returning();
  return { institution, deployment, course };
}

function buildTestApp(db: Database) {
  const app = Fastify({ logger: false });
  app.register(fastifyCookie);
  registerMeRoute(app, { requireSession: createRequireSession(db), db });
  return app;
}

// File scope so the shared module-level pg pool in db.ts is closed exactly once (see the same note
// in registrations.test.ts).
afterAll(async () => {
  await closeTestDb();
});

describe('GET /api/me', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("returns the documented §25.1 shape, sourced from the launch session and course", async () => {
    const { db } = getTestDb();
    const { institution, deployment, course } = await seedFullContext();
    const created = await createSession(db, {
      institutionId: institution.id,
      deploymentId: deployment.id,
      ltiSubject: 'user-1',
      displayName: 'Jane Instructor',
      courseId: course.id,
      roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'],
      ttlHours: 8,
    });
    const app = buildTestApp(db);

    const response = await app.inject({ method: 'GET', url: '/api/me', cookies: { [SESSION_COOKIE_NAME]: created.token } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      user: { displayName: 'Jane Instructor', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'] },
      institution: { name: 'Me Test University' },
      course: { id: course.id, label: 'ME101', title: 'Me Course' },
      permissions: { takeAttendance: true, editAttendance: true },
      csrfToken: created.csrfSecret,
    });
  });

  it('falls back to ltiSubject as displayName when the launch had no name claim', async () => {
    const { db } = getTestDb();
    const { institution, deployment, course } = await seedFullContext();
    const created = await createSession(db, {
      institutionId: institution.id,
      deploymentId: deployment.id,
      ltiSubject: 'user-no-name',
      displayName: null,
      courseId: course.id,
      roles: ['Instructor'],
      ttlHours: 8,
    });
    const app = buildTestApp(db);

    const response = await app.inject({ method: 'GET', url: '/api/me', cookies: { [SESSION_COOKIE_NAME]: created.token } });

    expect(response.json().user.displayName).toBe('user-no-name');
  });

  it('returns 401 without a valid session', async () => {
    const app = buildTestApp(getTestDb().db);
    const response = await app.inject({ method: 'GET', url: '/api/me' });
    expect(response.statusCode).toBe(401);
  });

  it('never leaks the raw session token or any Canvas endpoint/JWKS URL', async () => {
    const { db } = getTestDb();
    const { institution, deployment, course } = await seedFullContext();
    const created = await createSession(db, {
      institutionId: institution.id,
      deploymentId: deployment.id,
      ltiSubject: 'user-1',
      displayName: 'Jane Instructor',
      courseId: course.id,
      roles: ['Instructor'],
      ttlHours: 8,
    });
    const app = buildTestApp(db);

    const response = await app.inject({ method: 'GET', url: '/api/me', cookies: { [SESSION_COOKIE_NAME]: created.token } });
    const raw = JSON.stringify(response.json());

    expect(raw).not.toContain(created.token);
    expect(raw).not.toContain('secret-auth-endpoint');
    expect(raw).not.toContain('secret-token-endpoint');
    expect(raw).not.toContain('secret-jwks');
  });
});
