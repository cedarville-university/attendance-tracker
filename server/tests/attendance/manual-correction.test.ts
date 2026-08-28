// server/tests/attendance/manual-correction.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndCourse } from '../support/seed.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';
import { applyManualCorrection } from '../../src/attendance/manual-correction.js';
import { attendanceSessions, attendanceSessionMembers, attendanceRecords, auditEvents } from '../../src/database/schema.js';

const { db } = getTestDb();
// Seeding reads only platform.issuer / platform.jwksUri — no .start() needed.
const platform = new MockCanvasPlatform();
afterAll(() => closeTestDb());

beforeEach(async () => {
  await resetDb();
});

async function seedSessionWithScannedMember() {
  const { courseId } = await seedInstitutionAndCourse(db, platform);
  const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
  await db.insert(attendanceSessionMembers).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', displayName: 'Jane', eligibleForAttendance: true, status: 'Active', snapshotData: {} });
  await db.insert(attendanceRecords).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', clientScanId: 'scan-1', status: 'present', scannedAt: new Date(), source: 'card' });
  return session.id;
}

describe('applyManualCorrection', () => {
  it('inserts a new source=manual record (scannedAt null) rather than mutating the existing one', async () => {
    const sessionId = await seedSessionWithScannedMember();

    const result = await applyManualCorrection(db, sessionId, 'user-1', { status: 'excused', note: 'Institution-approved absence' }, 'instructor-1');

    expect(result.status).toBe('excused');
    expect(result.source).toBe('manual');
    expect(result.scannedAt).toBeNull();
    const allRecords = await db.select().from(attendanceRecords).where(and(eq(attendanceRecords.attendanceSessionId, sessionId), eq(attendanceRecords.ltiUserId, 'user-1')));
    expect(allRecords).toHaveLength(2); // original 'present' card scan untouched, new 'excused' manual record appended
    expect(allRecords.some((r) => r.status === 'present' && r.source === 'card')).toBe(true);
  });

  it('writes an attendance_manual_change audit event with actor/prev-status/new-status/note/requestId and no note column on attendance_records', async () => {
    const sessionId = await seedSessionWithScannedMember();

    const result = await applyManualCorrection(db, sessionId, 'user-1', { status: 'absent', note: 'Left early, unexcused' }, 'instructor-1', 'req-mc');

    expect(Object.keys(result)).not.toContain('note'); // matches spec §26's literal column list
    const events = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'attendance_manual_change'));
    expect(events).toHaveLength(1);
    expect(events[0].actorLtiUserId).toBe('instructor-1');
    expect(events[0].targetId).toBe('user-1');
    expect(events[0].requestId).toBe('req-mc');
    expect(events[0].oldValue).toMatchObject({ status: 'present' });
    expect(events[0].newValue).toMatchObject({ status: 'absent', note: 'Left early, unexcused' });
  });

  it('works for a member with no prior record (oldValue is null)', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    await db.insert(attendanceSessionMembers).values({ attendanceSessionId: session.id, ltiUserId: 'user-2', institutionalId: '2000000', displayName: 'No Scan', eligibleForAttendance: true, status: 'Active', snapshotData: {} });

    const result = await applyManualCorrection(db, session.id, 'user-2', { status: 'excused' }, 'instructor-1');

    expect(result.status).toBe('excused');
    const events = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'attendance_manual_change'));
    expect(events[0].oldValue).toBeNull();
  });
});
