import { beforeEach, afterAll, describe, it, expect } from 'vitest';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { institutions, ltiRegistrations, ltiDeployments, courses } from '../../src/database/schema.js';
import { createSession, findValidSession, revokeSession } from '../../src/auth/session.js';
import { buildSessionCookieOptions } from '../../src/auth/cookies.js';

async function seedCourseId(): Promise<{ institutionId: string; deploymentRowId: string; courseId: string }> {
  const { db } = getTestDb();
  const [institution] = await db
    .insert(institutions)
    .values({ slug: 'session-test', displayName: 'Session Test', timezone: 'UTC', enabled: true })
    .returning();
  const [registration] = await db
    .insert(ltiRegistrations)
    .values({
      institutionId: institution.id,
      issuer: 'https://session.test',
      clientId: 'session-client',
      oidcAuthEndpoint: 'https://session.test/a',
      tokenEndpoint: 'https://session.test/t',
      tokenAudience: 'https://session.test/t',
      platformJwksUri: 'https://session.test/jwks',
      enabled: true,
    })
    .returning();
  const [deployment] = await db
    .insert(ltiDeployments)
    .values({ registrationId: registration.id, deploymentId: 'session-deploy', enabled: true, configuration: {} })
    .returning();
  const [course] = await db
    .insert(courses)
    .values({ institutionId: institution.id, deploymentId: deployment.id, ltiContextId: 'session-course', label: 'S101' })
    .returning();
  return { institutionId: institution.id, deploymentRowId: deployment.id, courseId: course.id };
}

// File scope so the shared module-level pg pool in db.ts is closed exactly once, after every
// describe in this file has finished (see the same note in registrations.test.ts).
afterAll(async () => {
  await closeTestDb();
});

describe('createSession / findValidSession / revokeSession', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('creates a session, stores only its hash, and finds it back by the raw token', async () => {
    const { db } = getTestDb();
    const { institutionId, deploymentRowId, courseId } = await seedCourseId();

    const created = await createSession(db, {
      institutionId,
      deploymentId: deploymentRowId,
      ltiSubject: 'user-1',
      displayName: 'Jane Instructor',
      courseId,
      roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'],
      ttlHours: 8,
    });

    expect(Buffer.from(created.token, 'base64url').length).toBeGreaterThanOrEqual(32);

    const found = await findValidSession(db, created.token);
    expect(found).not.toBeNull();
    expect(found?.ltiSubject).toBe('user-1');
    expect(found?.displayName).toBe('Jane Instructor');
    expect(found?.roles).toEqual(['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor']);
    expect(found?.csrfSecret).toBe(created.csrfSecret);
  });

  it('never returns a session for a token that was never issued', async () => {
    const { db } = getTestDb();
    const found = await findValidSession(db, 'not-a-real-token');
    expect(found).toBeNull();
  });

  it('returns null after a session is revoked', async () => {
    const { db } = getTestDb();
    const { institutionId, deploymentRowId, courseId } = await seedCourseId();
    const created = await createSession(db, {
      institutionId,
      deploymentId: deploymentRowId,
      ltiSubject: 'user-2',
      displayName: null,
      courseId,
      roles: ['Instructor'],
      ttlHours: 8,
    });

    await revokeSession(db, created.sessionId);

    expect(await findValidSession(db, created.token)).toBeNull();
  });

  it('returns null for an already-expired session', async () => {
    const { db } = getTestDb();
    const { institutionId, deploymentRowId, courseId } = await seedCourseId();
    const created = await createSession(db, {
      institutionId,
      deploymentId: deploymentRowId,
      ltiSubject: 'user-3',
      displayName: null,
      courseId,
      roles: ['Instructor'],
      ttlHours: -1, // already expired
    });

    expect(await findValidSession(db, created.token)).toBeNull();
  });
});

describe('buildSessionCookieOptions', () => {
  it('sets secure:true for an https APP_BASE_URL', () => {
    const options = buildSessionCookieOptions('https://app.test', 8);
    expect(options).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 8 * 60 * 60 });
  });

  it('sets secure:false for an http APP_BASE_URL (local dev)', () => {
    const options = buildSessionCookieOptions('http://localhost:3000', 8);
    expect(options.secure).toBe(false);
  });
});
