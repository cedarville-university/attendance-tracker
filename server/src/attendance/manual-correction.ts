//
// Manual corrections always INSERT a new attendance_records row -- never
// UPDATE an existing one -- so member-status.ts's "most recent record wins"
// stays the single rule everywhere. The correction note lives only in
// audit_events.new_value (JSONB); there is deliberately no `note` column on
// attendance_records (spec §26's literal column list). 'late' is NOT an
// accepted status this phase (deferred, settled decision).

import { and, eq } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import { attendanceSessions, attendanceSessionMembers, attendanceRecords, auditEvents, courses, type AttendanceRecordRow } from '../database/schema.js';
import { resolveCurrentRecord } from './member-status.js';

// Coded client-fault errors (mirrors session-lifecycle.ts's `.code` convention).
// attendance-sessions.ts::replyForError maps both codes to 404; without a `.code`
// these would rethrow to Fastify's generic 500.
class ManualCorrectionError extends Error {
  constructor(
    message: string,
    public readonly code: 'session_not_found' | 'member_not_in_snapshot',
  ) {
    super(message);
  }
}

export async function applyManualCorrection(
  db: Database,
  sessionId: string,
  ltiUserId: string,
  input: { status: 'present' | 'absent' | 'excused'; note?: string },
  actorLtiUserId: string,
  requestId?: string,
): Promise<AttendanceRecordRow> {
  return db.transaction(async (tx) => {
    const [session] = await tx.select().from(attendanceSessions).where(eq(attendanceSessions.id, sessionId));
    if (!session) throw new ManualCorrectionError(`Attendance session ${sessionId} not found.`, 'session_not_found');

    const [member] = await tx
      .select()
      .from(attendanceSessionMembers)
      .where(and(eq(attendanceSessionMembers.attendanceSessionId, sessionId), eq(attendanceSessionMembers.ltiUserId, ltiUserId)));
    if (!member) throw new ManualCorrectionError(`No roster-snapshot member ${ltiUserId} in session ${sessionId}.`, 'member_not_in_snapshot');

    const priorRecords = await tx
      .select()
      .from(attendanceRecords)
      .where(and(eq(attendanceRecords.attendanceSessionId, sessionId), eq(attendanceRecords.ltiUserId, ltiUserId)));
    const priorCurrent = resolveCurrentRecord(priorRecords);

    const [inserted] = await tx
      .insert(attendanceRecords)
      .values({
        attendanceSessionId: sessionId,
        ltiUserId,
        institutionalId: member.institutionalId,
        clientScanId: null,
        status: input.status,
        scannedAt: null, // a manual correction was not "scanned at" this instant (spec §26)
        source: 'manual',
      })
      .returning();

    const [course] = await tx.select().from(courses).where(eq(courses.id, session.courseId));
    await tx.insert(auditEvents).values({
      institutionId: course.institutionId,
      courseId: session.courseId,
      attendanceSessionId: sessionId,
      actorLtiUserId,
      eventType: 'attendance_manual_change',
      targetType: 'attendance_session_member',
      targetId: ltiUserId,
      oldValue: priorCurrent ? { status: priorCurrent.status } : null,
      newValue: { status: input.status, note: input.note ?? null },
      requestId: requestId ?? null,
    });

    return inserted;
  });
}
