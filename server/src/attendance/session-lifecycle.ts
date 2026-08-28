import { eq } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import {
  attendanceSessions,
  attendanceSessionMembers,
  auditEvents,
  courses,
  type AttendanceSessionRow,
} from '../database/schema.js';
import type { ToolSigningKey } from '../lti/signing-keys.js';
import type { CourseRosterMember } from '../lti/nrps.js';
import { getRosterWithFallback } from './roster-store.js';

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
export class RosterUnavailableError extends Error {
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
    throw new RosterUnavailableError(err);
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
