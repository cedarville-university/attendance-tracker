import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndCourse } from '../support/seed.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';
import { createAttendanceSession, closeAttendanceSession, reopenAttendanceSession } from '../../src/attendance/session-lifecycle.js';
import { attendanceSessions, attendanceSessionMembers, attendanceRecords, auditEvents } from '../../src/database/schema.js';
import type { ToolSigningKey } from '../../src/lti/signing-keys.js';

// D9: Start Attendance goes through the shared fallback helper, so that is what we mock.
// vi.mock (not vi.spyOn) — an ESM named-export spy throws "Cannot redefine property"
// under some esbuild interop settings; Phase 4's route tests also use vi.mock (Q3).
vi.mock('../../src/attendance/roster-store.js', () => ({
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
