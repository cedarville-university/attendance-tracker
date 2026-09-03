import { beforeEach, afterAll, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import {
  institutions,
  ltiRegistrations,
  ltiDeployments,
  courses,
  appSessions,
  oidcTransactions,
  courseMembers,
  auditEvents,
  attendanceSessions,
  attendanceSessionMembers,
  attendanceRecords,
  gradeLineItems,
  gradeSyncJobs,
} from '../../src/database/schema.js';
import { seedInstitutionAndCourse } from '../support/seed.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';

// File scope, not inside a describe: the pg pool in tests/support/db.ts is module-level and shared
// by every describe in this file, so closing it from inside one describe would leave any later
// describe's re-created pool open (Vitest then warns about a hanging process).
afterAll(async () => {
  await closeTestDb();
});

describe('schema smoke test', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('can insert and read a full row chain across every Phase 3 table', async () => {
    const { db } = getTestDb();

    const [institution] = await db
      .insert(institutions)
      .values({ slug: 'smoke-test', displayName: 'Smoke Test University', timezone: 'UTC', enabled: true })
      .returning();
    expect(institution.id).toBeTruthy();

    const [registration] = await db
      .insert(ltiRegistrations)
      .values({
        institutionId: institution.id,
        issuer: 'https://smoke.test',
        clientId: 'client-smoke',
        oidcAuthEndpoint: 'https://smoke.test/authorize',
        tokenEndpoint: 'https://smoke.test/token',
        tokenAudience: 'https://smoke.test/token',
        platformJwksUri: 'https://smoke.test/jwks',
        enabled: true,
      })
      .returning();

    const [deployment] = await db
      .insert(ltiDeployments)
      .values({ registrationId: registration.id, deploymentId: 'deploy-smoke', enabled: true, configuration: {} })
      .returning();

    const [transaction] = await db
      .insert(oidcTransactions)
      .values({
        registrationId: registration.id,
        deploymentId: deployment.deploymentId,
        stateHash: 'state-hash-smoke',
        nonceHash: 'nonce-hash-smoke',
        targetLinkUri: 'https://smoke.test/index.html',
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      })
      .returning();
    expect(transaction.consumedAt).toBeNull();

    const [course] = await db
      .insert(courses)
      .values({ institutionId: institution.id, deploymentId: deployment.id, ltiContextId: 'course-smoke', label: 'SMOKE101', title: 'Smoke Course' })
      .returning();

    const [session] = await db
      .insert(appSessions)
      .values({
        sessionTokenHash: 'session-hash-smoke',
        institutionId: institution.id,
        deploymentId: deployment.id,
        ltiSubject: 'user-smoke',
        courseId: course.id,
        roles: ['Instructor'],
        csrfSecret: 'csrf-smoke',
        expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
      })
      .returning();

    expect(session.ltiSubject).toBe('user-smoke');
    expect(session.roles).toEqual(['Instructor']);
  });

  it('enforces UNIQUE(issuer, client_id) on lti_registrations', async () => {
    const { db } = getTestDb();
    const [institution] = await db
      .insert(institutions)
      .values({ slug: 'dup-test', displayName: 'Dup Test', timezone: 'UTC', enabled: true })
      .returning();

    const values = {
      institutionId: institution.id,
      issuer: 'https://dup.test',
      clientId: 'client-dup',
      oidcAuthEndpoint: 'https://dup.test/authorize',
      tokenEndpoint: 'https://dup.test/token',
      tokenAudience: 'https://dup.test/token',
      platformJwksUri: 'https://dup.test/jwks',
      enabled: true,
    };
    await db.insert(ltiRegistrations).values(values);

    await expect(db.insert(ltiRegistrations).values(values)).rejects.toThrow();
  });

  it('persists the Phase 4 columns and course_members / audit_events rows', async () => {
    const { db } = getTestDb();

    const [institution] = await db
      .insert(institutions)
      .values({ slug: 'p4-smoke', displayName: 'Phase 4 Smoke U', timezone: 'UTC', enabled: true })
      .returning();
    expect(institution.canvasIdentityMatchField).toBe('lis_person_sourcedid');
    expect(institution.identityMatchEmailEnabled).toBe(false);
    expect(institution.rosterLearnerRoles).toEqual(['Learner']);

    const [registration] = await db
      .insert(ltiRegistrations)
      .values({
        institutionId: institution.id,
        issuer: 'https://p4-smoke.test',
        clientId: 'client-p4',
        oidcAuthEndpoint: 'https://p4-smoke.test/authorize',
        tokenEndpoint: 'https://p4-smoke.test/token',
        tokenAudience: 'https://p4-smoke.test/token',
        platformJwksUri: 'https://p4-smoke.test/jwks',
        enabled: true,
      })
      .returning();
    const [deployment] = await db
      .insert(ltiDeployments)
      .values({ registrationId: registration.id, deploymentId: 'deploy-p4', enabled: true, configuration: {} })
      .returning();
    const [course] = await db
      .insert(courses)
      .values({
        institutionId: institution.id,
        deploymentId: deployment.id, // lti_deployments.id ROW UUID (NOT NULL FK)
        ltiContextId: 'course-p4',
        label: 'ENGR-101',
        title: 'Intro to Engineering',
        nrpsUrl: 'https://canvas.example.edu/api/lti/courses/1/names_and_roles',
      })
      .returning();
    expect(course.nrpsUrl).toBe('https://canvas.example.edu/api/lti/courses/1/names_and_roles');
    expect(course.rosterCachedAt).toBeNull();

    const [member] = await db
      .insert(courseMembers)
      .values({
        courseId: course.id,
        ltiUserId: 'user-1',
        institutionalId: '0001234',
        roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'],
        status: 'Active',
      })
      .returning();
    expect(member.institutionalId).toBe('0001234');

    const [event] = await db
      .insert(auditEvents)
      .values({
        institutionId: institution.id,
        courseId: course.id,
        eventType: 'roster_refreshed',
        targetType: 'course',
        targetId: course.id,
        newValue: { memberCount: 1 },
        requestId: 'req-abc',
      })
      .returning();
    expect(event.eventType).toBe('roster_refreshed');
    expect(event.requestId).toBe('req-abc');
  });
});

describe('Phase 5 schema', () => {
  it('attendance_sessions, attendance_session_members, attendance_records, audit_events exist and are queryable', async () => {
    const { db } = getTestDb();
    await resetDb();
    await expect(db.select().from(attendanceSessions).limit(1)).resolves.toEqual([]);
    await expect(db.select().from(attendanceSessionMembers).limit(1)).resolves.toEqual([]);
    await expect(db.select().from(attendanceRecords).limit(1)).resolves.toEqual([]);
    await expect(db.select().from(auditEvents).limit(1)).resolves.toEqual([]);
  });

  it('rejects a second attendance_records row with the same (attendanceSessionId, clientScanId)', async () => {
    const { db } = getTestDb();
    await resetDb();
    const { sessionId } = await seedCourseAndSession();
    await db.insert(attendanceRecords).values({
      attendanceSessionId: sessionId, ltiUserId: 'user-1', institutionalId: '1000000',
      clientScanId: 'scan-abc', status: 'present', scannedAt: new Date(), source: 'card',
    });
    let error: unknown;
    try {
      await db.insert(attendanceRecords).values({
        attendanceSessionId: sessionId, ltiUserId: 'user-1', institutionalId: '1000000',
        clientScanId: 'scan-abc', status: 'present', scannedAt: new Date(), source: 'card',
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    // drizzle-orm wraps the driver error; the pg "duplicate key" text is on `.cause`.
    const err = error as Error & { cause?: unknown };
    expect(String(err.cause ?? err.message)).toMatch(/duplicate key value violates unique constraint/);
  });

  it('accepts a manual record with a null scanned_at (spec §26 — scanned_at is nullable)', async () => {
    const { db } = getTestDb();
    await resetDb();
    const { sessionId } = await seedCourseAndSession();
    const [row] = await db.insert(attendanceRecords).values({
      attendanceSessionId: sessionId, ltiUserId: 'user-1', institutionalId: '1000000',
      clientScanId: null, status: 'excused', scannedAt: null, source: 'manual',
    }).returning();
    expect(row.scannedAt).toBeNull();
  });
});

describe('Phase 6 schema', () => {
  it('stores a grade line item (one per course) and grade-sync jobs (one per course+member)', async () => {
    const { db } = getTestDb();
    await resetDb();
    const { courseId } = await seedInstitutionAndCourse(db, new MockCanvasPlatform());

    const [li] = await db.insert(gradeLineItems).values({
      courseId,
      canvasLineItemId: '123',
      canvasLineItemUrl: 'https://canvas.example.edu/api/lti/courses/1/line_items/123',
      resourceId: 'attendance-cumulative-v1',
      tag: 'attendance',
      scoreMaximum: 100,
    }).returning();
    expect(li.id).toBeTruthy();

    // UNIQUE(course_id): a second line item for the same course is rejected.
    await expect(
      db.insert(gradeLineItems).values({
        courseId, canvasLineItemId: '999', canvasLineItemUrl: 'https://x/999',
        resourceId: 'attendance-cumulative-v1', tag: 'attendance', scoreMaximum: 100,
      }),
    ).rejects.toThrow();

    const [job] = await db.insert(gradeSyncJobs).values({
      courseId, ltiUserId: 'user-1', score: 94.5,
    }).returning();
    expect(job.state).toBe('pending');
    expect(job.attemptCount).toBe(0);
    expect(job.score).toBeCloseTo(94.5);

    // UNIQUE(course_id, lti_user_id): a second job for the same member is rejected.
    await expect(
      db.insert(gradeSyncJobs).values({ courseId, ltiUserId: 'user-1', score: 10 }),
    ).rejects.toThrow();
  });
});

describe('Session review schema (soft delete)', () => {
  it('attendance_sessions has nullable deleted_at / deleted_by_lti_user_id, defaulting to null', async () => {
    const { db } = getTestDb();
    await resetDb();
    const { sessionId } = await seedCourseAndSession();

    const [fresh] = await db.select().from(attendanceSessions).where(eq(attendanceSessions.id, sessionId));
    expect(fresh.deletedAt).toBeNull();
    expect(fresh.deletedByLtiUserId).toBeNull();

    const when = new Date('2026-09-01T15:00:00.000Z');
    await db
      .update(attendanceSessions)
      .set({ deletedAt: when, deletedByLtiUserId: 'instructor-9' })
      .where(eq(attendanceSessions.id, sessionId));

    const [updated] = await db.select().from(attendanceSessions).where(eq(attendanceSessions.id, sessionId));
    expect(updated.deletedAt?.toISOString()).toBe(when.toISOString());
    expect(updated.deletedByLtiUserId).toBe('instructor-9');
  });
});

// Builds the real FK chain institutions -> lti_registrations -> lti_deployments -> courses,
// so courses.deployment_id points at an lti_deployments.id ROW UUID (never institutions.id).
async function seedCourseAndSession() {
  const { db } = getTestDb();
  const s = randomUUID();
  const [institution] = await db.insert(institutions)
    .values({ slug: `schema-test-${s}`, displayName: 'Schema Test U', timezone: 'UTC', enabled: true }).returning();
  const [registration] = await db.insert(ltiRegistrations).values({
    institutionId: institution.id, issuer: `https://canvas-${s}.test`, clientId: `client-${s}`,
    oidcAuthEndpoint: 'https://canvas.test/auth', tokenEndpoint: 'https://canvas.test/token',
    tokenAudience: 'https://canvas.test/token', platformJwksUri: 'https://canvas.test/jwks', enabled: true,
  }).returning();
  const [deployment] = await db.insert(ltiDeployments)
    .values({ registrationId: registration.id, deploymentId: `dep-${s}`, enabled: true, configuration: {} }).returning();
  const [course] = await db.insert(courses)
    .values({ institutionId: institution.id, deploymentId: deployment.id, ltiContextId: `ctx-${s}`, label: 'TEST101', title: 'Test Course' }).returning();
  const [session] = await db.insert(attendanceSessions)
    .values({ courseId: course.id, startedByLtiUserId: 'instructor-1' }).returning();
  return { sessionId: session.id };
}
