import { eq } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import {
  attendanceSessions,
  attendanceSessionMembers,
  attendanceRecords,
  auditEvents,
  courses,
  type AttendanceSessionRow,
} from '../database/schema.js';
import type { ToolSigningKey } from '../lti/signing-keys.js';
import type { CourseRosterMember } from '../lti/nrps.js';
import { getRosterWithFallback } from './roster-store.js';
import { resolveCurrentRecord } from './member-status.js';
import { recomputeCourseGrades } from './grade-recompute.js';

// The optional test-injection fields mirror Phase 4's getRosterWithFallback deps so a
// caller can stub the Canvas fetch; signingKey is REQUIRED (Phase 4 D5 — no module-level
// key). Threaded index.ts -> route deps (Task 12) -> here -> getRosterWithFallback.
export interface CreateAttendanceSessionDeps {
  signingKey: ToolSigningKey;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
}

// Phase 3 ships no db.transaction() precedent, so helpers that receive `tx` type it
// as this alias rather than the non-existent `typeof db` (Q15 / B5 defect 3).
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export class SessionClosedError extends Error {
  code = 'session_closed' as const;
  constructor() {
    super('Attendance session is closed; scans are not accepted.');
  }
}
export class SessionAlreadyClosedError extends Error {
  code = 'session_already_closed' as const;
  constructor() {
    super('Attendance session is already closed.');
  }
}
export class SessionNotClosedError extends Error {
  code = 'session_not_closed' as const;
  constructor() {
    super('Only a closed attendance session can be reopened.');
  }
}
// Renamed from RosterUnavailableError to avoid colliding with the identically
// named class in roster-store.ts (different ctor + different discriminant: this
// one carries `.code`, that one carries `.kind`). attendance-sessions.ts
// duck-types `.code`; course-roster.ts uses `instanceof` on the roster-store one.
export class SessionRosterUnavailableError extends Error {
  code = 'roster_unavailable' as const;
  constructor(cause: unknown) {
    super('Cannot start an attendance session: the course roster is unavailable and no recent cache exists.');
    this.cause = cause;
  }
}

export async function createAttendanceSession(
  db: Database,
  courseId: string,
  startedByLtiUserId: string,
  body: { label?: string; meetingAt?: string },
  requestId: string | undefined,
  deps: CreateAttendanceSessionDeps,
): Promise<AttendanceSessionRow> {
  // D9/S2: getRosterWithFallback returns a fresh fetch, else a <24h cache with
  // stale:true, and only THROWS when there is neither. A transient Canvas 429
  // mid-class must not block Start Attendance. deps.signingKey is threaded straight
  // through — Phase 4's helper needs it to sign the client-assertion JWT on a live fetch.
  let roster: { members: CourseRosterMember[]; fetchedAt: string; stale: boolean; refreshed: boolean };
  try {
    roster = await getRosterWithFallback(db, courseId, {
      signingKey: deps.signingKey,
      fetchImpl: deps.fetchImpl,
      sleepImpl: deps.sleepImpl,
      now: deps.now,
    });
  } catch (err) {
    throw new SessionRosterUnavailableError(err);
  }

  return db.transaction(async (tx) => {
    const [course] = await tx.select().from(courses).where(eq(courses.id, courseId));
    if (!course) throw new Error(`Course ${courseId} not found.`);

    const [session] = await tx
      .insert(attendanceSessions)
      .values({
        courseId,
        startedByLtiUserId,
        label: body.label ?? null,
        meetingAt: body.meetingAt ? new Date(body.meetingAt) : null,
        state: 'open',
      })
      .returning();

    if (roster.members.length > 0) {
      await tx.insert(attendanceSessionMembers).values(
        roster.members.map((m) => ({
          attendanceSessionId: session.id,
          ltiUserId: m.ltiUserId,
          institutionalId: m.institutionalId,
          displayName: m.displayName,
          eligibleForAttendance: m.eligibleForAttendance,
          status: m.status,
          snapshotData: m,
        })),
      );
    }

    await tx.insert(auditEvents).values({
      institutionId: course.institutionId,
      courseId,
      attendanceSessionId: session.id,
      actorLtiUserId: startedByLtiUserId,
      eventType: 'attendance_session_created',
      targetType: 'attendance_session',
      targetId: session.id,
      newValue: { memberCount: roster.members.length, stale: roster.stale, rosterFetchedAt: roster.fetchedAt },
      requestId: requestId ?? null,
    });

    return session;
  });
}

export async function closeAttendanceSession(
  db: Database,
  sessionId: string,
  actorLtiUserId: string,
  requestId?: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    // D1: row-lock the session so two concurrent Close calls can't both pass the
    // state guard and each write a set of system_absence + audit rows.
    const [session] = await tx.select().from(attendanceSessions).where(eq(attendanceSessions.id, sessionId)).for('update');
    if (!session) throw new Error(`Attendance session ${sessionId} not found.`);
    if (session.state === 'closed') throw new SessionAlreadyClosedError(); // Q7 state guard

    // B5: load the course once and use course.institutionId unconditionally
    // (audit_events.institutionId is NOT NULL).
    const [course] = await tx.select().from(courses).where(eq(courses.id, session.courseId));

    const members = await tx.select().from(attendanceSessionMembers).where(eq(attendanceSessionMembers.attendanceSessionId, sessionId));
    const records = await tx.select().from(attendanceRecords).where(eq(attendanceRecords.attendanceSessionId, sessionId));
    const recordsByLtiUserId = new Map<string, typeof records>();
    for (const record of records) {
      if (!record.ltiUserId) continue;
      const list = recordsByLtiUserId.get(record.ltiUserId) ?? [];
      list.push(record);
      recordsByLtiUserId.set(record.ltiUserId, list);
    }

    const now = new Date();
    const absentInserts = members
      .filter((m) => m.eligibleForAttendance)
      .filter((m) => resolveCurrentRecord(recordsByLtiUserId.get(m.ltiUserId) ?? []) === null)
      .map((m) => ({
        attendanceSessionId: sessionId,
        ltiUserId: m.ltiUserId,
        institutionalId: m.institutionalId,
        clientScanId: null,
        status: 'absent' as const,
        scannedAt: null, // system_absence rows were never "scanned at" an instant (spec §26)
        source: 'system_absence' as const,
      }));

    if (absentInserts.length > 0) {
      await tx.insert(attendanceRecords).values(absentInserts);
    }

    await tx.update(attendanceSessions).set({ state: 'closed', closedAt: now, updatedAt: now }).where(eq(attendanceSessions.id, sessionId));

    await tx.insert(auditEvents).values({
      institutionId: course.institutionId,
      courseId: session.courseId,
      attendanceSessionId: sessionId,
      actorLtiUserId,
      eventType: 'attendance_session_closed',
      targetType: 'attendance_session',
      targetId: sessionId,
      newValue: { markedAbsentCount: absentInserts.length },
      requestId: requestId ?? null,
    });

    // Phase 6 cumulative recompute + durable enqueue (spec §25.7 steps 3-4, §28 steps 2-3),
    // shared with soft delete / restore. `state='closed'` is already applied above in this txn.
    await recomputeCourseGrades(tx, db, session.courseId, sessionId, actorLtiUserId, requestId);
  });
}

export async function reopenAttendanceSession(
  db: Database,
  sessionId: string,
  actorLtiUserId: string,
  reason?: string,
  requestId?: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    // D1: row-lock the session so two concurrent Reopen calls can't both pass the
    // state guard and each write an audit row.
    const [session] = await tx.select().from(attendanceSessions).where(eq(attendanceSessions.id, sessionId)).for('update');
    if (!session) throw new Error(`Attendance session ${sessionId} not found.`);
    if (session.state !== 'closed') throw new SessionNotClosedError(); // Q7 state guard

    const [course] = await tx.select().from(courses).where(eq(courses.id, session.courseId)); // B5

    await tx.update(attendanceSessions).set({ state: 'reopened', closedAt: null, updatedAt: new Date() }).where(eq(attendanceSessions.id, sessionId));

    await tx.insert(auditEvents).values({
      institutionId: course.institutionId,
      courseId: session.courseId,
      attendanceSessionId: sessionId,
      actorLtiUserId,
      eventType: 'attendance_session_reopened',
      targetType: 'attendance_session',
      targetId: sessionId,
      newValue: { reason: reason ?? null },
      requestId: requestId ?? null,
    });
  });
}
