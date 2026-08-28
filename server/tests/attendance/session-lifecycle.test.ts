import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndCourse } from '../support/seed.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';
import { createAttendanceSession } from '../../src/attendance/session-lifecycle.js';
import { attendanceSessionMembers, auditEvents } from '../../src/database/schema.js';
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

  it('hard-fails (RosterUnavailableError) only when getRosterWithFallback itself throws — no fetch AND no <24h cache', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    vi.mocked(getRosterWithFallback).mockRejectedValue(new Error('canvas down, cache is 3 days old'));

    await expect(createAttendanceSession(db, courseId, 'instructor-1', {}, undefined, { signingKey })).rejects.toMatchObject({ code: 'roster_unavailable' });
  });
});
