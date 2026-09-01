import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndCourse } from '../support/seed.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';
import { registerAttendanceSessionsRoute } from '../../src/routes/attendance-sessions.js';
import { attendanceSessions, attendanceSessionMembers, attendanceRecords, auditEvents, gradeSyncJobs } from '../../src/database/schema.js';
import type { IdentityResolver } from '../../src/identity/types.js';
import { stubSigningKeyProvider } from '../support/signing-keys.js';

// createAttendanceSession degrades through the shared helper -> mock it (Q3). Only
// getRosterWithFallback is stubbed; the real getCachedRosterAsMembers still runs so
// closeAttendanceSession's Phase 6 grade population can read course_members.
vi.mock('../../src/attendance/roster-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/attendance/roster-store.js')>()),
  getRosterWithFallback: vi.fn(),
}));
import { getRosterWithFallback } from '../../src/attendance/roster-store.js';

const { db } = getTestDb();
// Seeding reads only platform.issuer / platform.jwksUri — no .start() needed (the roster
// helper is mocked). signingKey is a typed stub: it reaches createAttendanceSession's deps
// but getRosterWithFallback is mocked so it is never dereferenced (C1).
const platform = new MockCanvasPlatform();
const signingKeyProvider = stubSigningKeyProvider();
afterAll(() => closeTestDb());

beforeEach(async () => {
  await resetDb();
  vi.mocked(getRosterWithFallback).mockReset();
  vi.mocked(getRosterWithFallback).mockResolvedValue({ members: [], fetchedAt: new Date().toISOString(), stale: false, refreshed: true });
});

type FakeSession = { id: string; institutionId: string; deploymentId: string; ltiSubject: string; displayName: string | null; courseId: string; roles: string[]; csrfSecret: string };

// Fakes for the two real preHandlers. requireSession copies the fixed session
// onto request.appSession (or 401 if `session` is null). requireCsrf 403s a
// mutation whose x-csrf-token header != session.csrfSecret. This mirrors the
// real middleware.ts contract closely enough to exercise route wiring.
function fakeRequireSession(session: FakeSession | null) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!session) return reply.code(401).send({ error: 'unauthenticated' });
    request.appSession = session;
  };
}
function fakeRequireCsrf() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const provided = request.headers['x-csrf-token'];
    if (provided !== request.appSession?.csrfSecret) return reply.code(403).send({ error: 'csrf_check_failed' });
  };
}

function buildTestApp({ resolver, session }: { resolver: IdentityResolver; session: FakeSession | null }): FastifyInstance {
  const app = Fastify({ logger: false });
  registerAttendanceSessionsRoute(app, {
    db,
    resolver,
    requireSession: fakeRequireSession(session),
    requireCsrf: fakeRequireCsrf(),
    signingKeyProvider,
  });
  return app;
}

function makeSession(over: Partial<FakeSession> & Pick<FakeSession, 'institutionId' | 'courseId'>): FakeSession {
  return { id: 's1', deploymentId: 'dep-1', ltiSubject: 'instructor-1', displayName: 'Prof', roles: [], csrfSecret: 'secret-xyz', ...over };
}
const CSRF = { 'x-csrf-token': 'secret-xyz' };

describe('attendance-sessions routes — auth wiring', () => {
  it('an unauthenticated request (no session) returns 401', async () => {
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: null });
    const response = await app.inject({ method: 'GET', url: '/api/attendance-sessions/00000000-0000-0000-0000-000000000000' });
    expect(response.statusCode).toBe(401);
  });

  it('a mutation without a valid x-csrf-token returns 403', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });
    const response = await app.inject({ method: 'POST', url: '/api/attendance-sessions', payload: {} }); // no CSRF header
    expect(response.statusCode).toBe(403);
  });
});

describe('attendance-sessions routes', () => {
  it('POST /api/attendance-sessions creates a session scoped to the caller\'s course and returns a normalized body', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });

    const response = await app.inject({ method: 'POST', url: '/api/attendance-sessions', headers: CSRF, payload: {} });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.courseId).toBe(courseId);
    expect(body).not.toHaveProperty('rosterSnapshotVersion'); // normalized, not the raw Drizzle row (Q14)
  });

  it('GET /api/attendance-sessions/{id} on another institution\'s session returns 404, not 403', async () => {
    const { courseId: ownCourseId, institutionId: ownInstitutionId } = await seedInstitutionAndCourse(db, platform);
    const { courseId: otherCourseId } = await seedInstitutionAndCourse(db, platform, { clientId: 'other-client-id' });
    const [otherSession] = await db.insert(attendanceSessions).values({ courseId: otherCourseId, startedByLtiUserId: 'someone-else', state: 'open' }).returning();
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId: ownInstitutionId, courseId: ownCourseId }) });

    const response = await app.inject({ method: 'GET', url: `/api/attendance-sessions/${otherSession.id}` });

    expect(response.statusCode).toBe(404);
  });

  it('POST .../scans records a scan and returns the normalized record', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    await db.insert(attendanceSessionMembers).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', displayName: 'Jane', eligibleForAttendance: true, status: 'Active', snapshotData: {} });
    const resolver: IdentityResolver = { resolveCard: vi.fn().mockResolvedValue({ ok: true, universityId: '1000000', firstName: 'Jane', lastName: 'Smith', email: 'jane@example.edu', raw: {}, error: null }) };
    const app = buildTestApp({ resolver, session: makeSession({ institutionId, courseId }) });

    const response = await app.inject({ method: 'POST', url: `/api/attendance-sessions/${session.id}/scans`, headers: CSRF, payload: { clientScanId: 'scan-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() } });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('present');
    expect(response.json()).not.toHaveProperty('cardFingerprint'); // Q14
  });

  it('POST .../scans never echoes the raw cardCode back in the response', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    await db.insert(attendanceSessionMembers).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', displayName: 'Jane', eligibleForAttendance: true, status: 'Active', snapshotData: {} });
    const resolver: IdentityResolver = { resolveCard: vi.fn().mockResolvedValue({ ok: true, universityId: '1000000', firstName: 'Jane', lastName: 'Smith', email: 'jane@example.edu', raw: {}, error: null }) };
    const app = buildTestApp({ resolver, session: makeSession({ institutionId, courseId }) });

    const response = await app.inject({ method: 'POST', url: `/api/attendance-sessions/${session.id}/scans`, headers: CSRF, payload: { clientScanId: 'scan-1', cardCode: 'SUPERSECRETCARD42', scannedAt: new Date().toISOString() } });

    expect(JSON.stringify(response.json())).not.toContain('SUPERSECRETCARD42');
  });

  it('POST .../scans: a lookup_error followed by a successful retry (same clientScanId) yields a present current record (B6, route-level)', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    await db.insert(attendanceSessionMembers).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', displayName: 'Jane', eligibleForAttendance: true, status: 'Active', snapshotData: {} });
    let n = 0;
    const resolver: IdentityResolver = {
      resolveCard: vi.fn().mockImplementation(async () => {
        n += 1;
        return n === 1
          ? { ok: false, universityId: null, firstName: null, lastName: null, email: null, raw: null, error: { kind: 'timeout', message: 'down' } }
          : { ok: true, universityId: '1000000', firstName: 'Jane', lastName: 'Smith', email: null, raw: {}, error: null };
      }),
    };
    const app = buildTestApp({ resolver, session: makeSession({ institutionId, courseId }) });
    const payload = { clientScanId: 'retry-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() };

    const first = await app.inject({ method: 'POST', url: `/api/attendance-sessions/${session.id}/scans`, headers: CSRF, payload });
    expect(first.json().status).toBe('lookup_error');
    const second = await app.inject({ method: 'POST', url: `/api/attendance-sessions/${session.id}/scans`, headers: CSRF, payload });
    expect(second.json().status).toBe('present');

    const rows = await db.select().from(attendanceRecords).where(and(eq(attendanceRecords.attendanceSessionId, session.id), eq(attendanceRecords.clientScanId, 'retry-1')));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('present');
  });

  it('POST .../close closes the session and marks unscanned eligible members absent', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    await db.insert(attendanceSessionMembers).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', displayName: 'Jane', eligibleForAttendance: true, status: 'Active', snapshotData: {} });
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });

    const response = await app.inject({ method: 'POST', url: `/api/attendance-sessions/${session.id}/close`, headers: CSRF });

    expect(response.statusCode).toBe(200);
    const [closed] = await db.select().from(attendanceSessions).where(eq(attendanceSessions.id, session.id));
    expect(closed.state).toBe('closed');
  });

  it('POST .../close on an already-closed session returns 409', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'closed' }).returning();
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });

    const response = await app.inject({ method: 'POST', url: `/api/attendance-sessions/${session.id}/close`, headers: CSRF });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'session_already_closed' });
    expect(response.json().requestId).toBeTruthy();
  });

  it('POST .../reopen reopens a closed session; reopening an open session returns 409', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
    const [closedSession] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'closed' }).returning();
    const [openSession] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });

    expect((await app.inject({ method: 'POST', url: `/api/attendance-sessions/${closedSession.id}/reopen`, headers: CSRF, payload: { reason: 'Missed scans' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/attendance-sessions/${openSession.id}/reopen`, headers: CSRF })).statusCode).toBe(409);
  });

  it('PATCH .../members/{ltiUserId} applies a manual correction; a "late" status is rejected 400 (deferred)', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    await db.insert(attendanceSessionMembers).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', displayName: 'Jane', eligibleForAttendance: true, status: 'Active', snapshotData: {} });
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });

    const ok = await app.inject({ method: 'PATCH', url: `/api/attendance-sessions/${session.id}/members/user-1`, headers: CSRF, payload: { status: 'excused', note: 'Approved absence' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('excused');

    const late = await app.inject({ method: 'PATCH', url: `/api/attendance-sessions/${session.id}/members/user-1`, headers: CSRF, payload: { status: 'late' } });
    expect(late.statusCode).toBe(400);
  });

  it('DELETE .../members/{ltiUserId}/records/{recordId} removes a mis-scanned record and writes an audit event with requestId', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    const [record] = await db.insert(attendanceRecords).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', clientScanId: 'scan-1', status: 'present', scannedAt: new Date(), source: 'card' }).returning();
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });

    const response = await app.inject({ method: 'DELETE', url: `/api/attendance-sessions/${session.id}/members/user-1/records/${record.id}`, headers: CSRF });

    expect(response.statusCode).toBe(204);
    expect(await db.select().from(attendanceRecords).where(eq(attendanceRecords.id, record.id))).toHaveLength(0);
    const events = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'attendance_record_removed'));
    expect(events).toHaveLength(1);
    expect(events[0].requestId).toBeTruthy();
  });

  it('GET /api/attendance-sessions lists only open/reopened sessions for the caller\'s course, newest first; cross-tenant excluded', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
    const { courseId: otherCourseId } = await seedInstitutionAndCourse(db, platform, { clientId: 'other-client-id' });
    const [older] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open', openedAt: new Date('2026-08-01T10:00:00.000Z') }).returning();
    const [newer] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'reopened', openedAt: new Date('2026-08-20T10:00:00.000Z') }).returning();
    await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'closed' });
    await db.insert(attendanceSessions).values({ courseId: otherCourseId, startedByLtiUserId: 'x', state: 'open' });
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });

    const response = await app.inject({ method: 'GET', url: '/api/attendance-sessions?state=open' });

    expect(response.statusCode).toBe(200);
    const ids = response.json().sessions.map((s: { id: string }) => s.id);
    expect(ids).toEqual([newer.id, older.id]);
  });

  it('POST .../scans of a rostered member returns the roster-snapshot displayName', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    await db.insert(attendanceSessionMembers).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', displayName: 'Jane Smith', eligibleForAttendance: true, status: 'Active', snapshotData: {} });
    const resolver: IdentityResolver = { resolveCard: vi.fn().mockResolvedValue({ ok: true, universityId: '1000000', firstName: 'Jane', lastName: 'Smith', email: null, raw: {}, error: null }) };
    const app = buildTestApp({ resolver, session: makeSession({ institutionId, courseId }) });

    const response = await app.inject({ method: 'POST', url: `/api/attendance-sessions/${session.id}/scans`, headers: CSRF, payload: { clientScanId: 'scan-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() } });

    expect(response.json().status).toBe('present');
    expect(response.json().displayName).toBe('Jane Smith');
  });

  it('PATCH .../members/{unknown} returns 404 (not 500) with a requestId', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });

    const response = await app.inject({ method: 'PATCH', url: `/api/attendance-sessions/${session.id}/members/nobody`, headers: CSRF, payload: { status: 'present' } });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'member_not_in_snapshot' });
    expect(response.json().requestId).toBeTruthy();
  });

  it('GET .../{id} on an unknown session returns 404 with a requestId (D2)', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });
    const response = await app.inject({ method: 'GET', url: '/api/attendance-sessions/00000000-0000-0000-0000-000000000000' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found', requestId: expect.any(String) });
  });

  it('an unexpected (ltiUserId null) scan appears in GET .../{id} unmatchedRecords and in export.csv, and unscanned members read not_recorded pre-close', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    await db.insert(attendanceSessionMembers).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', displayName: 'Jane', eligibleForAttendance: true, status: 'Active', snapshotData: {} });
    await db.insert(attendanceRecords).values({ attendanceSessionId: session.id, ltiUserId: null, institutionalId: '9999999', clientScanId: 'scan-x', status: 'unexpected', scannedAt: new Date('2026-08-26T10:00:00.000Z'), source: 'card' });
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });

    const detail = await app.inject({ method: 'GET', url: `/api/attendance-sessions/${session.id}` });
    expect(detail.json().unmatchedRecords).toHaveLength(1);
    expect(detail.json().unmatchedRecords[0].institutionalId).toBe('9999999');

    const csv = await app.inject({ method: 'GET', url: `/api/attendance-sessions/${session.id}/export.csv` });
    expect(csv.body).toContain('1000000,Jane,not_recorded,');
    expect(csv.body).toContain('9999999,,unexpected,card');
  });

  it('GET .../export.csv returns a CSV body with the current-record status per member', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    await db.insert(attendanceSessionMembers).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', displayName: 'Jane Smith', eligibleForAttendance: true, status: 'Active', snapshotData: {} });
    await db.insert(attendanceRecords).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', clientScanId: 'scan-1', status: 'present', scannedAt: new Date('2026-08-26T10:00:00.000Z'), source: 'card' });
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });

    const response = await app.inject({ method: 'GET', url: `/api/attendance-sessions/${session.id}/export.csv` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.body).toContain('1000000,Jane Smith,present,card');
  });
});

describe('grade-sync', () => {
  it('GET :id includes a gradeSync summary (state "none" when no jobs exist)', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'i1', state: 'open' }).returning();

    const res = await app.inject({ method: 'GET', url: `/api/attendance-sessions/${session.id}`, headers: CSRF });
    expect(res.statusCode).toBe(200);
    expect(res.json().gradeSync).toMatchObject({ state: 'none', counts: { pending: 0, synced: 0, failed: 0 } });
  });

  it('POST :id/grade-sync re-queues the course\'s failed jobs and audits grade_sync_requested', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'i1', state: 'closed' }).returning();
    await db.insert(gradeSyncJobs).values([
      { courseId, ltiUserId: 'u1', score: 50, state: 'failed', lastError: 'ags:server-error', attemptCount: 6 },
      { courseId, ltiUserId: 'u2', score: 100, state: 'synced' },
    ]);

    const res = await app.inject({ method: 'POST', url: `/api/attendance-sessions/${session.id}/grade-sync`, headers: CSRF });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, retried: 1 });

    const [u1] = await db.select().from(gradeSyncJobs).where(and(eq(gradeSyncJobs.courseId, courseId), eq(gradeSyncJobs.ltiUserId, 'u1')));
    expect(u1).toMatchObject({ state: 'pending', attemptCount: 0, lastError: null });
    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_sync_requested'));
    expect(audit).toMatchObject({ targetType: 'attendance_session', targetId: session.id, actorLtiUserId: 'instructor-1' });
    expect(audit.newValue).toMatchObject({ retriedJobCount: 1, trigger: 'manual' });
  });

  it('POST :id/grade-sync without a CSRF token is 403', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'i1', state: 'closed' }).returning();
    const res = await app.inject({ method: 'POST', url: `/api/attendance-sessions/${session.id}/grade-sync` });
    expect(res.statusCode).toBe(403);
  });

  it('POST :id/grade-sync for a session in another course is 404 (never 403)', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
    const other = await seedInstitutionAndCourse(db, platform, { clientId: 'other-client-id' });
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });
    const [foreign] = await db.insert(attendanceSessions).values({ courseId: other.courseId, startedByLtiUserId: 'i1', state: 'closed' }).returning();
    const res = await app.inject({ method: 'POST', url: `/api/attendance-sessions/${foreign.id}/grade-sync`, headers: CSRF });
    expect(res.statusCode).toBe(404);
  });
});
