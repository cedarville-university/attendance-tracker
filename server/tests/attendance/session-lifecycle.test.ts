import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndCourse } from '../support/seed.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';
import {
  createAttendanceSession,
  closeAttendanceSession,
  reopenAttendanceSession,
  softDeleteAttendanceSession,
  restoreAttendanceSession,
  SessionAlreadyDeletedError,
  SessionNotDeletedError,
} from '../../src/attendance/session-lifecycle.js';
import { attendanceSessions, attendanceSessionMembers, attendanceRecords, auditEvents, gradeSyncJobs, courseMembers } from '../../src/database/schema.js';
import type { ToolSigningKey } from '../../src/lti/signing-keys.js';

// D9: Start Attendance goes through the shared fallback helper, so that is what we mock.
// vi.mock (not vi.spyOn) — an ESM named-export spy throws "Cannot redefine property"
// under some esbuild interop settings; Phase 4's route tests also use vi.mock (Q3).
// Only getRosterWithFallback is stubbed — the real getCachedRosterAsMembers still runs so the
// Phase 6 grade population reads the course_members rows each test seeds.
vi.mock('../../src/attendance/roster-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/attendance/roster-store.js')>()),
  getRosterWithFallback: vi.fn(),
}));
import { getRosterWithFallback } from '../../src/attendance/roster-store.js';

const { db } = getTestDb();
afterAll(() => closeTestDb());

// Seeding only reads platform.issuer / platform.jwksUri — no .start() needed, the
// roster fetch is mocked. signingKey is a typed stub: getRosterWithFallback is mocked
// so the key is never used, but createAttendanceSession's deps type requires it (C1).
const platform = new MockCanvasPlatform();
const signingKey = {} as ToolSigningKey;

beforeEach(async () => {
  await resetDb();
  vi.mocked(getRosterWithFallback).mockReset();
});

function member(overrides: Partial<import('../../src/lti/nrps.js').CourseRosterMember> = {}) {
  return {
    ltiUserId: 'user-1',
    institutionalId: '1000000',
    displayName: 'Jane Smith',
    givenName: 'Jane',
    familyName: 'Smith',
    email: 'jane@example.edu',
    roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'],
    status: 'Active',
    eligibleForAttendance: true,
    ...overrides,
  };
}

// The N1 grade population reads course_members directly; seed it to match the mocked roster.
// File-scoped so every describe (close, and later soft-delete / restore) can reuse it.
async function seedCourseMembers(courseId: string, ms: ReturnType<typeof member>[]) {
  await db.insert(courseMembers).values(
    ms.map((m) => ({
      courseId,
      ltiUserId: m.ltiUserId,
      institutionalId: m.institutionalId,
      displayName: m.displayName,
      givenName: m.givenName,
      familyName: m.familyName,
      email: m.email,
      roles: m.roles,
      status: m.status, // 'Active' -> eligible for a Learner; 'Inactive' -> not
    })),
  );
}

describe('createAttendanceSession', () => {
  it('snapshots every roster member verbatim into attendance_session_members and writes an attendance_session_created audit event', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    const members = [member(), member({ ltiUserId: 'user-2', institutionalId: '2000000', eligibleForAttendance: false, status: 'Inactive' })];
    vi.mocked(getRosterWithFallback).mockResolvedValue({ members, fetchedAt: new Date().toISOString(), stale: false, refreshed: true });

    const session = await createAttendanceSession(db, courseId, 'instructor-1', {}, 'req-1', { signingKey });

    const rows = await db.select().from(attendanceSessionMembers).where(eq(attendanceSessionMembers.attendanceSessionId, session.id));
    expect(rows).toHaveLength(2);
    const row1 = rows.find((r) => r.ltiUserId === 'user-1')!;
    expect(row1.institutionalId).toBe('1000000');
    expect(row1.eligibleForAttendance).toBe(true);
    expect(row1.status).toBe('Active');
    expect(row1.snapshotData).toEqual(members[0]);

    const [event] = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'attendance_session_created'));
    expect(event.actorLtiUserId).toBe('instructor-1');
    expect(event.requestId).toBe('req-1');
    expect(event.institutionId).not.toBeNull();
    expect(event.newValue).toMatchObject({ memberCount: 2, stale: false });
  });

  it('sets state=open, startedByLtiUserId, and optional label/meetingAt from the request body', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    vi.mocked(getRosterWithFallback).mockResolvedValue({ members: [], fetchedAt: new Date().toISOString(), stale: false, refreshed: true });

    const session = await createAttendanceSession(db, courseId, 'instructor-1', { label: 'Monday lecture', meetingAt: '2026-08-26T14:00:00Z' }, undefined, { signingKey });

    expect(session.state).toBe('open');
    expect(session.startedByLtiUserId).toBe('instructor-1');
    expect(session.label).toBe('Monday lecture');
    expect(session.courseId).toBe(courseId);
  });

  it('degrades to a <24h cache: creates the session from the stale roster and records stale=true in the audit event (S2)', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    vi.mocked(getRosterWithFallback).mockResolvedValue({ members: [member()], fetchedAt: '2026-08-26T09:00:00.000Z', stale: true, refreshed: false });

    const session = await createAttendanceSession(db, courseId, 'instructor-1', {}, undefined, { signingKey });

    const rows = await db.select().from(attendanceSessionMembers).where(eq(attendanceSessionMembers.attendanceSessionId, session.id));
    expect(rows).toHaveLength(1);
    const [event] = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'attendance_session_created'));
    expect(event.newValue).toMatchObject({ stale: true, rosterFetchedAt: '2026-08-26T09:00:00.000Z' });
  });

  it('hard-fails (SessionRosterUnavailableError) only when getRosterWithFallback itself throws — no fetch AND no <24h cache', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    vi.mocked(getRosterWithFallback).mockRejectedValue(new Error('canvas down, cache is 3 days old'));

    await expect(createAttendanceSession(db, courseId, 'instructor-1', {}, undefined, { signingKey })).rejects.toMatchObject({ code: 'roster_unavailable' });
  });
});

describe('closeAttendanceSession', () => {
  it('inserts a system_absence record (scannedAt null) for every eligible member with no qualifying record, sets state=closed, and writes an audit event with requestId', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    await db.insert(attendanceSessionMembers).values([
      { attendanceSessionId: session.id, ltiUserId: 'scanned-user', institutionalId: '1000000', displayName: 'Scanned', eligibleForAttendance: true, status: 'Active', snapshotData: {} },
      { attendanceSessionId: session.id, ltiUserId: 'unscanned-user', institutionalId: '2000000', displayName: 'Unscanned', eligibleForAttendance: true, status: 'Active', snapshotData: {} },
      { attendanceSessionId: session.id, ltiUserId: 'ineligible-user', institutionalId: '3000000', displayName: 'Ineligible', eligibleForAttendance: false, status: 'Inactive', snapshotData: {} },
    ]);
    await db.insert(attendanceRecords).values({
      attendanceSessionId: session.id, ltiUserId: 'scanned-user', institutionalId: '1000000',
      clientScanId: 'scan-1', status: 'present', scannedAt: new Date(), source: 'card',
    });

    await closeAttendanceSession(db, session.id, 'instructor-1', 'req-close');

    const [closed] = await db.select().from(attendanceSessions).where(eq(attendanceSessions.id, session.id));
    expect(closed.state).toBe('closed');
    expect(closed.closedAt).not.toBeNull();

    const records = await db.select().from(attendanceRecords).where(eq(attendanceRecords.attendanceSessionId, session.id));
    const absenceRecords = records.filter((r) => r.source === 'system_absence');
    expect(absenceRecords).toHaveLength(1);
    expect(absenceRecords[0].ltiUserId).toBe('unscanned-user');
    expect(absenceRecords[0].status).toBe('absent');
    expect(absenceRecords[0].scannedAt).toBeNull();

    const events = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'attendance_session_closed'));
    expect(events).toHaveLength(1);
    expect(events[0].actorLtiUserId).toBe('instructor-1');
    expect(events[0].requestId).toBe('req-close');
    expect(events[0].institutionId).not.toBeNull();
  });

  it('does not mark system_absence for a member who already has a qualifying record (e.g. a manual excused correction)', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    await db.insert(attendanceSessionMembers).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', displayName: 'Jane', eligibleForAttendance: true, status: 'Active', snapshotData: {} });
    await db.insert(attendanceRecords).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', clientScanId: null, status: 'excused', scannedAt: null, source: 'manual' });

    await closeAttendanceSession(db, session.id, 'instructor-1');

    const records = await db.select().from(attendanceRecords).where(eq(attendanceRecords.attendanceSessionId, session.id));
    expect(records.filter((r) => r.source === 'system_absence')).toHaveLength(0);
  });

  it('D1: two concurrent closes write exactly one set of system_absence rows and one audit row', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    await db.insert(attendanceSessionMembers).values([
      { attendanceSessionId: session.id, ltiUserId: 'u1', institutionalId: '1000000', displayName: 'A', eligibleForAttendance: true, status: 'Active', snapshotData: {} },
      { attendanceSessionId: session.id, ltiUserId: 'u2', institutionalId: '2000000', displayName: 'B', eligibleForAttendance: true, status: 'Active', snapshotData: {} },
    ]);

    const results = await Promise.allSettled([
      closeAttendanceSession(db, session.id, 'instructor-1', 'req-a'),
      closeAttendanceSession(db, session.id, 'instructor-1', 'req-b'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);

    const records = await db.select().from(attendanceRecords).where(eq(attendanceRecords.attendanceSessionId, session.id));
    expect(records.filter((r) => r.source === 'system_absence')).toHaveLength(2);
    const events = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'attendance_session_closed'));
    expect(events).toHaveLength(1);
  });

  it('rejects a second close with a 409-mapped error (state guard, Q7)', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'closed' }).returning();

    await expect(closeAttendanceSession(db, session.id, 'instructor-1')).rejects.toMatchObject({ code: 'session_already_closed' });
  });

  // --- Phase 6: cumulative grade calculation + durable grade-sync enqueue on close ---

  it('enqueues one pending grade_sync_job per eligible current-roster member and writes a grade_sync_requested audit row', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    const members = [
      member({ ltiUserId: 'u-present', institutionalId: '111' }),
      member({ ltiUserId: 'u-absent', institutionalId: '222' }),
      member({ ltiUserId: 'u-inelig', institutionalId: '333', eligibleForAttendance: false, status: 'Inactive' }),
    ];
    vi.mocked(getRosterWithFallback).mockResolvedValue({ members, fetchedAt: new Date().toISOString(), stale: false, refreshed: true });
    await seedCourseMembers(courseId, members);
    const session = await createAttendanceSession(db, courseId, 'i1', {}, 'req-open', { signingKey });

    // u-present scans present; u-absent never scans -> close marks them system_absence.
    await db.insert(attendanceRecords).values({
      attendanceSessionId: session.id, ltiUserId: 'u-present', institutionalId: '111',
      clientScanId: 's1', status: 'present', source: 'card', scannedAt: new Date(),
    });

    await closeAttendanceSession(db, session.id, 'i1', 'req-close');

    const jobs = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId));
    const byUser = new Map(jobs.map((j) => [j.ltiUserId, j]));
    expect(byUser.get('u-present')).toMatchObject({ state: 'pending', attemptCount: 0 });
    expect(byUser.get('u-present')!.score).toBeCloseTo(100);
    expect(byUser.get('u-absent')!.score).toBeCloseTo(0);
    expect(byUser.has('u-inelig')).toBe(false); // Inactive -> isEligibleForAttendance false -> not graded
    expect(byUser.get('u-present')!.attendanceSessionId).toBe(session.id);

    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_sync_requested'));
    expect(audit).toMatchObject({ targetType: 'attendance_session', targetId: session.id, actorLtiUserId: 'i1', requestId: 'req-close' });
    expect(audit.newValue).toMatchObject({ jobCount: 2, closedSessionCount: 1 });
    expect(audit.institutionId).not.toBeNull();
  });

  it('recomputes cumulatively and UPDATES the same job rows when a second session in the course closes', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    const members = [member({ ltiUserId: 'u1', institutionalId: '111' })];
    vi.mocked(getRosterWithFallback).mockResolvedValue({ members, fetchedAt: new Date().toISOString(), stale: false, refreshed: true });
    await seedCourseMembers(courseId, members);

    // Session A: present -> 100
    const a = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });
    await db.insert(attendanceRecords).values({ attendanceSessionId: a.id, ltiUserId: 'u1', institutionalId: '111', clientScanId: 'a1', status: 'present', source: 'card', scannedAt: new Date() });
    await closeAttendanceSession(db, a.id, 'i1', 'ra');

    // Session B: absent (system_absence at close) -> cumulative 1/2 -> 50
    const b = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });
    await closeAttendanceSession(db, b.id, 'i1', 'rb');

    const jobs = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId));
    expect(jobs).toHaveLength(1); // upserted, not appended
    expect(jobs[0].score).toBeCloseTo(50);
    expect(jobs[0].state).toBe('pending');
    expect(jobs[0].attendanceSessionId).toBe(b.id); // stamped with the latest triggering session
  });

  it('excludes a reopened session from the cumulative denominator (spec §25.8, 2026-08-28 ruling)', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    const members = [member({ ltiUserId: 'u1', institutionalId: '111' })];
    vi.mocked(getRosterWithFallback).mockResolvedValue({ members, fetchedAt: new Date().toISOString(), stale: false, refreshed: true });
    await seedCourseMembers(courseId, members);

    // Session A: absent -> would drag the average to 1/2 = 50 if it were still counted.
    const a = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });
    await closeAttendanceSession(db, a.id, 'i1', 'ra');
    await reopenAttendanceSession(db, a.id, 'i1', 'correcting', 'rr'); // A is now 'reopened'

    // Session B: present. Only B is 'closed', so the score is 1/1 -> 100.
    const b = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });
    await db.insert(attendanceRecords).values({
      attendanceSessionId: b.id, ltiUserId: 'u1', institutionalId: '111',
      clientScanId: 'b1', status: 'present', source: 'card', scannedAt: new Date(),
    });
    await closeAttendanceSession(db, b.id, 'i1', 'rb');

    const jobs = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].score).toBeCloseTo(100);
    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_sync_requested')).orderBy(auditEvents.id);
    expect(audit).toBeTruthy();
  });

  it('excludes a SOFT-DELETED closed session from a later close\'s cumulative recompute', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    const members = [member({ ltiUserId: 'u1', institutionalId: '111' })];
    vi.mocked(getRosterWithFallback).mockResolvedValue({ members, fetchedAt: new Date().toISOString(), stale: false, refreshed: true });
    await seedCourseMembers(courseId, members);

    // Session A: closed with an ABSENT outcome (system_absence at close) -> would drag to 50 if counted.
    const a = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });
    await closeAttendanceSession(db, a.id, 'i1', 'ra');
    // Soft-delete A directly (Task 3 wires the real path; here we only need the column set).
    await db.update(attendanceSessions).set({ deletedAt: new Date() }).where(eq(attendanceSessions.id, a.id));

    // Session B: present. Only B is a live closed session -> score is 1/1 -> 100.
    const b = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });
    await db.insert(attendanceRecords).values({
      attendanceSessionId: b.id, ltiUserId: 'u1', institutionalId: '111',
      clientScanId: 'b1', status: 'present', source: 'card', scannedAt: new Date(),
    });
    await closeAttendanceSession(db, b.id, 'i1', 'rb');

    const jobs = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].score).toBeCloseTo(100);
  });

  it('enqueues no jobs (but still audits) when the current roster has no eligible members', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    vi.mocked(getRosterWithFallback).mockResolvedValue({ members: [], fetchedAt: new Date().toISOString(), stale: false, refreshed: true });
    // no seedCourseMembers -> course_members is empty
    const session = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });

    await closeAttendanceSession(db, session.id, 'i1', 'rc');

    expect(await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId))).toHaveLength(0);
    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_sync_requested'));
    expect(audit.newValue).toMatchObject({ jobCount: 0 });
  });
});

describe('reopenAttendanceSession', () => {
  it('sets state=reopened, clears closedAt, and writes an audit event including reason + requestId', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'closed', closedAt: new Date() }).returning();

    await reopenAttendanceSession(db, session.id, 'instructor-1', 'Student reported a missed scan', 'req-reopen');

    const [reopened] = await db.select().from(attendanceSessions).where(eq(attendanceSessions.id, session.id));
    expect(reopened.state).toBe('reopened');
    expect(reopened.closedAt).toBeNull();

    const events = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'attendance_session_reopened'));
    expect(events).toHaveLength(1);
    expect(events[0].actorLtiUserId).toBe('instructor-1');
    expect(events[0].requestId).toBe('req-reopen');
    expect(events[0].newValue).toMatchObject({ reason: 'Student reported a missed scan' });
  });

  it('reopened is a scan-accepting state (not closed)', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'closed' }).returning();
    await reopenAttendanceSession(db, session.id, 'instructor-1');

    const [reopened] = await db.select().from(attendanceSessions).where(eq(attendanceSessions.id, session.id));
    expect(reopened.state).not.toBe('closed');
  });

  it('rejects reopening a session that is not closed with a 409-mapped error (state guard, Q7)', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();

    await expect(reopenAttendanceSession(db, session.id, 'instructor-1')).rejects.toMatchObject({ code: 'session_not_closed' });
  });
});

describe('softDeleteAttendanceSession / restoreAttendanceSession', () => {
  it('soft-deletes an OPEN session: sets deleted_at/by, no grade recompute, audits attendance_session_deleted', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    vi.mocked(getRosterWithFallback).mockResolvedValue({ members: [], fetchedAt: new Date().toISOString(), stale: false, refreshed: true });
    const s = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });

    const result = await softDeleteAttendanceSession(db, s.id, 'instructor-7', 'req-del');

    expect(result).toEqual({ gradeRecompute: false, jobCount: 0 });
    const [row] = await db.select().from(attendanceSessions).where(eq(attendanceSessions.id, s.id));
    expect(row.deletedAt).not.toBeNull();
    expect(row.deletedByLtiUserId).toBe('instructor-7');
    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'attendance_session_deleted'));
    expect(audit).toMatchObject({ actorLtiUserId: 'instructor-7', targetType: 'attendance_session', targetId: s.id, requestId: 'req-del' });
    expect(audit.newValue).toMatchObject({ gradeRecompute: false, jobCount: 0 });
    // no grade_sync_requested audit row for an open-session delete
    expect(await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_sync_requested'))).toHaveLength(0);
  });

  it('soft-deleting a CLOSED session recomputes the course grades without it', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    const members = [member({ ltiUserId: 'u1', institutionalId: '111' })];
    vi.mocked(getRosterWithFallback).mockResolvedValue({ members, fetchedAt: new Date().toISOString(), stale: false, refreshed: true });
    await seedCourseMembers(courseId, members);

    // A: present -> 100.  B: absent -> cumulative 50.
    const a = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });
    await db.insert(attendanceRecords).values({ attendanceSessionId: a.id, ltiUserId: 'u1', institutionalId: '111', clientScanId: 'a1', status: 'present', source: 'card', scannedAt: new Date() });
    await closeAttendanceSession(db, a.id, 'i1', 'ra');
    const b = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });
    await closeAttendanceSession(db, b.id, 'i1', 'rb');
    expect((await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId)))[0].score).toBeCloseTo(50);

    // Delete B -> only A counts -> 100.
    const result = await softDeleteAttendanceSession(db, b.id, 'i1', 'req-del');
    expect(result.gradeRecompute).toBe(true);
    const [job] = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId));
    expect(job.score).toBeCloseTo(100);
  });

  it('rejects a double delete with SessionAlreadyDeletedError', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    vi.mocked(getRosterWithFallback).mockResolvedValue({ members: [], fetchedAt: new Date().toISOString(), stale: false, refreshed: true });
    const s = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });
    await softDeleteAttendanceSession(db, s.id, 'i1');
    await expect(softDeleteAttendanceSession(db, s.id, 'i1')).rejects.toBeInstanceOf(SessionAlreadyDeletedError);
  });

  it('restore clears the columns, audits attendance_session_restored, and recomputes for a closed session', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    const members = [member({ ltiUserId: 'u1', institutionalId: '111' })];
    vi.mocked(getRosterWithFallback).mockResolvedValue({ members, fetchedAt: new Date().toISOString(), stale: false, refreshed: true });
    await seedCourseMembers(courseId, members);

    const a = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });
    await closeAttendanceSession(db, a.id, 'i1', 'ra'); // absent -> job score 0
    await softDeleteAttendanceSession(db, a.id, 'i1');   // no live closed sessions now

    const result = await restoreAttendanceSession(db, a.id, 'instructor-3', 'req-res');
    expect(result.gradeRecompute).toBe(true);
    const [row] = await db.select().from(attendanceSessions).where(eq(attendanceSessions.id, a.id));
    expect(row.deletedAt).toBeNull();
    expect(row.deletedByLtiUserId).toBeNull();
    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'attendance_session_restored'));
    expect(audit).toMatchObject({ actorLtiUserId: 'instructor-3', targetId: a.id, requestId: 'req-res' });
  });

  it('rejects restoring a session that is not deleted with SessionNotDeletedError', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    vi.mocked(getRosterWithFallback).mockResolvedValue({ members: [], fetchedAt: new Date().toISOString(), stale: false, refreshed: true });
    const s = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });
    await expect(restoreAttendanceSession(db, s.id, 'i1')).rejects.toBeInstanceOf(SessionNotDeletedError);
  });
});
