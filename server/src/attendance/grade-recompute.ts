import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import type { Tx } from './session-lifecycle.js';
import { attendanceSessions, attendanceRecords, auditEvents, courses } from '../database/schema.js';
import { getCachedRosterAsMembers } from './roster-store.js';
import { resolveCurrentRecord } from './member-status.js';
import { DEFAULT_GRADING_POLICY } from './grade-policy.js';
import { computeCumulativeScores, type SessionResolvedStatuses } from './grade-calc.js';
import { upsertGradeSyncJobs } from './grade-sync-store.js';

export interface RecomputeResult {
  jobCount: number;
  closedSessionCount: number;
  eligibleMemberCount: number;
}

/**
 * The single implementation of the Phase 6 cumulative-grade recompute (spec §25.7 steps 3-4,
 * §28 steps 2-3). Extracted from closeAttendanceSession so close, soft-delete, and restore all
 * behave identically.
 *
 * Population = the course's CURRENT roster (course_members, refreshed on every Start Attendance).
 * Denominator = every non-deleted CLOSED session in the course. 'reopened' sessions are excluded
 * (mid-correction) and soft-deleted sessions are excluded (deleted_at IS NULL).
 *
 * CALLER CONTRACT: apply your own state change to the triggering session INSIDE `tx` before
 * calling — close sets state='closed'; soft-delete sets deleted_at; restore clears deleted_at —
 * so the scan below sees the correct set. Writes one `grade_sync_requested` audit row.
 *
 * `tx` runs every write and the session/record reads (transactional consistency). `db` is only
 * for getCachedRosterAsMembers, which is typed `db: Database` and reads tables this txn never
 * mutates (course_members / institutions / courses).
 */
export async function recomputeCourseGrades(
  tx: Tx,
  db: Database,
  courseId: string,
  triggeringSessionId: string,
  actorLtiUserId: string,
  requestId: string | undefined,
): Promise<RecomputeResult> {
  const [course] = await tx.select().from(courses).where(eq(courses.id, courseId));

  const currentRoster = await getCachedRosterAsMembers(db, courseId);
  const eligibleLtiUserIds = (currentRoster?.members ?? [])
    .filter((m) => m.eligibleForAttendance)
    .map((m) => m.ltiUserId);

  const closedSessions = await tx
    .select({ id: attendanceSessions.id })
    .from(attendanceSessions)
    .where(
      and(
        eq(attendanceSessions.courseId, courseId),
        eq(attendanceSessions.state, 'closed'),
        isNull(attendanceSessions.deletedAt),
      ),
    );
  const closedSessionIds = closedSessions.map((s) => s.id);

  const allRecords = closedSessionIds.length
    ? await tx.select().from(attendanceRecords).where(inArray(attendanceRecords.attendanceSessionId, closedSessionIds))
    : [];

  const resolvedBySession: SessionResolvedStatuses[] = closedSessionIds.map((closedId) => {
    const perUser = new Map<string, typeof allRecords>();
    for (const rec of allRecords) {
      if (rec.attendanceSessionId !== closedId || !rec.ltiUserId) continue;
      const list = perUser.get(rec.ltiUserId) ?? [];
      list.push(rec);
      perUser.set(rec.ltiUserId, list);
    }
    const statusByLtiUserId = new Map<string, 'present' | 'absent' | 'excused'>();
    for (const [ltiUserId, recs] of perUser) {
      const current = resolveCurrentRecord(recs);
      if (current && (current.status === 'present' || current.status === 'absent' || current.status === 'excused')) {
        statusByLtiUserId.set(ltiUserId, current.status);
      }
    }
    return { sessionId: closedId, statusByLtiUserId };
  });

  const scores = computeCumulativeScores(resolvedBySession, eligibleLtiUserIds, DEFAULT_GRADING_POLICY);
  const jobCount = await upsertGradeSyncJobs(
    tx,
    courseId,
    triggeringSessionId,
    new Map([...scores].map(([ltiUserId, s]) => [ltiUserId, { scoreGiven: s.scoreGiven }])),
  );

  await tx.insert(auditEvents).values({
    institutionId: course.institutionId,
    courseId,
    attendanceSessionId: triggeringSessionId,
    actorLtiUserId,
    eventType: 'grade_sync_requested',
    targetType: 'attendance_session',
    targetId: triggeringSessionId,
    newValue: { jobCount, closedSessionCount: closedSessionIds.length, eligibleMemberCount: eligibleLtiUserIds.length },
    requestId: requestId ?? null,
  });

  return { jobCount, closedSessionCount: closedSessionIds.length, eligibleMemberCount: eligibleLtiUserIds.length };
}
