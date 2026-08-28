// server/src/routes/attendance-sessions.ts
//
// Every route requires request.appSession (from the injected requireSession
// preHandler); every mutation also requires requireCsrf. Every session/record
// lookup is scoped to request.appSession.courseId; a resource in a different
// course returns 404 (never 403) to avoid leaking existence across tenants.
// Errors are mapped to opaque codes + request.id (spec §31.9) -- no internal
// Error.message reaches the client.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import { attendanceSessions, attendanceSessionMembers, attendanceRecords, auditEvents, courses, type AttendanceRecordRow, type AttendanceSessionRow } from '../database/schema.js';
import { createAttendanceSession, closeAttendanceSession, reopenAttendanceSession } from '../attendance/session-lifecycle.js';
import { submitScan } from '../attendance/scan-service.js';
import { applyManualCorrection } from '../attendance/manual-correction.js';
import { buildAttendanceSessionCsv } from '../attendance/csv-export.js';
import { resolveCurrentRecord } from '../attendance/member-status.js';
import { getGradeSyncSummary, resetFailedJobs } from '../attendance/grade-sync-store.js';
import type { IdentityResolver } from '../identity/types.js';
import type { ToolSigningKey } from '../lti/signing-keys.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface AttendanceSessionsRouteDeps {
  db: Database;
  resolver: IdentityResolver;
  requireSession: PreHandler;
  requireCsrf: PreHandler;
  // C1: the active ToolSigningKey, injected from index.ts (getActiveSigningKey(signingKeys)).
  // Threaded into createAttendanceSession -> getRosterWithFallback for the Start-Attendance
  // roster fetch (Phase 4 D5 — no module-level key accessor).
  signingKey: ToolSigningKey;
}

const createSessionSchema = z.object({ label: z.string().optional(), meetingAt: z.string().datetime().optional() });
const scanSchema = z.object({ clientScanId: z.string().min(1), cardCode: z.string().min(1), scannedAt: z.string().datetime() });
// 'late' deliberately omitted -- deferred this phase (settled decision / S4).
const manualCorrectionSchema = z.object({ status: z.enum(['present', 'absent', 'excused']), note: z.string().optional() });
const reopenSchema = z.object({ reason: z.string().optional() }).optional();

// Q14: never return the raw Drizzle row -- serialize an explicit shape.
function serializeSession(s: AttendanceSessionRow) {
  return { id: s.id, courseId: s.courseId, state: s.state, label: s.label, meetingAt: s.meetingAt, openedAt: s.openedAt, closedAt: s.closedAt, startedByLtiUserId: s.startedByLtiUserId };
}
function serializeRecord(r: AttendanceRecordRow) {
  return { id: r.id, attendanceSessionId: r.attendanceSessionId, ltiUserId: r.ltiUserId, institutionalId: r.institutionalId, clientScanId: r.clientScanId, status: r.status, source: r.source, scannedAt: r.scannedAt, lookupErrorKind: r.lookupErrorKind };
}

const HTTP_FOR_CODE: Record<string, number> = {
  session_closed: 409,
  session_already_closed: 409,
  session_not_closed: 409,
  roster_unavailable: 502,
  session_not_found: 404,
  member_not_in_snapshot: 404,
};

/** Map a thrown service error to an opaque response, or rethrow for Fastify's 500. */
function replyForError(request: FastifyRequest, reply: FastifyReply, err: unknown): FastifyReply {
  const code = (err as { code?: string }).code;
  // A mapped business code (session already closed, member not on roster, ...) is
  // an expected client-driven outcome, not a server fault -- log it at warn and
  // keep `error` for the genuinely-unexpected rethrow path (D3).
  if (code && HTTP_FOR_CODE[code]) {
    request.log.warn({ err, reqId: request.id }, 'attendance-sessions business error');
    return reply.code(HTTP_FOR_CODE[code]).send({ error: code, requestId: request.id });
  }
  request.log.error({ err, reqId: request.id }, 'attendance-sessions route error');
  throw err;
}

/** request.appSession is augmented by middleware.ts; guard the undefined case (Q5). */
function sessionOf(request: FastifyRequest, reply: FastifyReply) {
  const s = request.appSession;
  if (!s) {
    reply.code(401).send({ error: 'unauthenticated' });
    return null;
  }
  return s;
}

export function registerAttendanceSessionsRoute(app: FastifyInstance, deps: AttendanceSessionsRouteDeps): void {
  const { db } = deps;
  const mutation = { preHandler: [deps.requireSession, deps.requireCsrf] as PreHandler[] };
  const readOnly = { preHandler: deps.requireSession };

  async function loadSessionScopedToCourse(sessionId: string, courseId: string) {
    const [session] = await db.select().from(attendanceSessions).where(and(eq(attendanceSessions.id, sessionId), eq(attendanceSessions.courseId, courseId)));
    return session ?? null;
  }

  // C1: session resume after a page reload / Canvas re-launch. Returns the
  // caller's course's still-open sessions (state open OR reopened), newest first,
  // so the client can re-attach instead of silently dropping every scan or
  // creating a duplicate open session. Tenant-scoped exactly like the others.
  app.get('/api/attendance-sessions', readOnly, async (request, reply) => {
    const session = sessionOf(request, reply);
    if (!session) return;
    const rows = await db
      .select()
      .from(attendanceSessions)
      .where(and(eq(attendanceSessions.courseId, session.courseId), inArray(attendanceSessions.state, ['open', 'reopened'])));
    rows.sort((a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime());
    return { sessions: rows.map(serializeSession) };
  });

  app.post('/api/attendance-sessions', mutation, async (request, reply) => {
    const session = sessionOf(request, reply);
    if (!session) return;
    const parsed = createSessionSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', requestId: request.id });
    try {
      const created = await createAttendanceSession(db, session.courseId, session.ltiSubject, parsed.data, request.id, { signingKey: deps.signingKey });
      return reply.code(201).send(serializeSession(created));
    } catch (err) {
      return replyForError(request, reply, err);
    }
  });

  app.get('/api/attendance-sessions/:id', readOnly, async (request, reply) => {
    const session = sessionOf(request, reply);
    if (!session) return;
    const { id } = request.params as { id: string };
    const row = await loadSessionScopedToCourse(id, session.courseId);
    if (!row) return reply.code(404).send({ error: 'not_found', requestId: request.id });

    const members = await db.select().from(attendanceSessionMembers).where(eq(attendanceSessionMembers.attendanceSessionId, id));
    const records = await db.select().from(attendanceRecords).where(eq(attendanceRecords.attendanceSessionId, id));
    const byUser = groupRecordsByUser(records);

    return {
      session: serializeSession(row),
      members: members.map((m) => ({
        ltiUserId: m.ltiUserId,
        displayName: m.displayName,
        institutionalId: m.institutionalId,
        eligibleForAttendance: m.eligibleForAttendance,
        currentRecord: mapCurrent(resolveCurrentRecord(byUser.get(m.ltiUserId) ?? [])),
      })),
      // B3: unexpected / lookup_error scans have a null ltiUserId, so they never
      // appear in the per-member view. Surface them explicitly so a page reload
      // (C1 rehydrate) doesn't silently drop them.
      unmatchedRecords: records.filter((r) => !r.ltiUserId).map(serializeRecord),
      // Phase 6: cumulative grade-sync status for this session's course (spec §28 UI states).
      // Use `row.courseId` — the session row being served; `loadSessionScopedToCourse` already
      // tenant-scoped it, so it equals the session's course.
      gradeSync: await getGradeSyncSummary(db, row.courseId),
    };
  });

  app.post('/api/attendance-sessions/:id/scans', mutation, async (request, reply) => {
    const session = sessionOf(request, reply);
    if (!session) return;
    const { id } = request.params as { id: string };
    const row = await loadSessionScopedToCourse(id, session.courseId);
    if (!row) return reply.code(404).send({ error: 'not_found', requestId: request.id });

    const parsed = scanSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', requestId: request.id });

    try {
      const record = await submitScan(db, id, parsed.data, {
        resolver: deps.resolver,
        institution: { id: session.institutionId, cardFingerprintEnabled: process.env.CARD_FINGERPRINT_SECRET != null },
      });
      // B2: the roster snapshot is the only source of a student's name -- thread
      // the matched member's displayName through so the client's Name column and
      // Latest-Scan panel aren't blank. unexpected / lookup_error rows have no
      // ltiUserId and therefore no name.
      let displayName: string | null = null;
      if (record.ltiUserId) {
        const [member] = await db
          .select({ displayName: attendanceSessionMembers.displayName })
          .from(attendanceSessionMembers)
          .where(and(eq(attendanceSessionMembers.attendanceSessionId, id), eq(attendanceSessionMembers.ltiUserId, record.ltiUserId)));
        displayName = member?.displayName ?? null;
      }
      return { ...serializeRecord(record), displayName };
    } catch (err) {
      return replyForError(request, reply, err);
    }
  });

  app.patch('/api/attendance-sessions/:id/members/:ltiUserId', mutation, async (request, reply) => {
    const session = sessionOf(request, reply);
    if (!session) return;
    const { id, ltiUserId } = request.params as { id: string; ltiUserId: string };
    const row = await loadSessionScopedToCourse(id, session.courseId);
    if (!row) return reply.code(404).send({ error: 'not_found', requestId: request.id });

    const parsed = manualCorrectionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', requestId: request.id });

    try {
      const record = await applyManualCorrection(db, id, ltiUserId, parsed.data, session.ltiSubject, request.id);
      return serializeRecord(record);
    } catch (err) {
      return replyForError(request, reply, err);
    }
  });

  app.delete('/api/attendance-sessions/:id/members/:ltiUserId/records/:recordId', mutation, async (request, reply) => {
    const session = sessionOf(request, reply);
    if (!session) return;
    const { id, ltiUserId, recordId } = request.params as { id: string; ltiUserId: string; recordId: string };
    const row = await loadSessionScopedToCourse(id, session.courseId);
    if (!row) return reply.code(404).send({ error: 'not_found', requestId: request.id });

    const [record] = await db
      .select()
      .from(attendanceRecords)
      .where(and(eq(attendanceRecords.id, recordId), eq(attendanceRecords.attendanceSessionId, id), eq(attendanceRecords.ltiUserId, ltiUserId)));
    if (!record) return reply.code(404).send({ error: 'not_found', requestId: request.id });

    const [course] = await db.select().from(courses).where(eq(courses.id, row.courseId));
    await db.transaction(async (tx) => {
      await tx.delete(attendanceRecords).where(eq(attendanceRecords.id, recordId));
      await tx.insert(auditEvents).values({
        institutionId: course.institutionId,
        courseId: row.courseId,
        attendanceSessionId: id,
        actorLtiUserId: session.ltiSubject,
        eventType: 'attendance_record_removed',
        targetType: 'attendance_record',
        targetId: recordId,
        oldValue: { status: record.status, source: record.source },
        requestId: request.id,
      });
    });

    return reply.code(204).send();
  });

  app.post('/api/attendance-sessions/:id/close', mutation, async (request, reply) => {
    const session = sessionOf(request, reply);
    if (!session) return;
    const { id } = request.params as { id: string };
    const row = await loadSessionScopedToCourse(id, session.courseId);
    if (!row) return reply.code(404).send({ error: 'not_found', requestId: request.id });
    try {
      await closeAttendanceSession(db, id, session.ltiSubject, request.id);
      return { ok: true };
    } catch (err) {
      return replyForError(request, reply, err);
    }
  });

  app.post('/api/attendance-sessions/:id/reopen', mutation, async (request, reply) => {
    const session = sessionOf(request, reply);
    if (!session) return;
    const { id } = request.params as { id: string };
    const row = await loadSessionScopedToCourse(id, session.courseId);
    if (!row) return reply.code(404).send({ error: 'not_found', requestId: request.id });

    const parsed = reopenSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', requestId: request.id });
    try {
      await reopenAttendanceSession(db, id, session.ltiSubject, parsed.data?.reason, request.id);
      return { ok: true };
    } catch (err) {
      return replyForError(request, reply, err);
    }
  });

  // Phase 6 (spec §25.9): manual retry of this course's failed grade-sync jobs.
  // CSRF-gated mutation; cross-tenant lookups 404 (never 403) like the siblings.
  app.post('/api/attendance-sessions/:id/grade-sync', mutation, async (request, reply) => {
    const session = sessionOf(request, reply);
    if (!session) return;
    const { id } = request.params as { id: string };
    const row = await loadSessionScopedToCourse(id, session.courseId);
    if (!row) return reply.code(404).send({ error: 'not_found', requestId: request.id });

    const retried = await resetFailedJobs(db, row.courseId, new Date());
    const [course] = await db.select().from(courses).where(eq(courses.id, row.courseId));
    await db.insert(auditEvents).values({
      institutionId: course.institutionId,
      courseId: row.courseId,
      attendanceSessionId: id,
      actorLtiUserId: session.ltiSubject,
      eventType: 'grade_sync_requested',
      targetType: 'attendance_session',
      targetId: id,
      newValue: { retriedJobCount: retried, trigger: 'manual' },
      requestId: request.id,
    });
    return { ok: true, retried };
  });

  app.get('/api/attendance-sessions/:id/export.csv', readOnly, async (request, reply) => {
    const session = sessionOf(request, reply);
    if (!session) return;
    const { id } = request.params as { id: string };
    const row = await loadSessionScopedToCourse(id, session.courseId);
    if (!row) return reply.code(404).send({ error: 'not_found', requestId: request.id });

    const members = await db.select().from(attendanceSessionMembers).where(eq(attendanceSessionMembers.attendanceSessionId, id));
    const records = await db.select().from(attendanceRecords).where(eq(attendanceRecords.attendanceSessionId, id));
    const byUser = groupRecordsByUser(records);

    const exportRows = members.map((m) => {
      const current = resolveCurrentRecord(byUser.get(m.ltiUserId) ?? []);
      return {
        ltiUserId: m.ltiUserId,
        institutionalId: m.institutionalId,
        displayName: m.displayName,
        // B4: pre-close (session still open, no system_absence rows yet) a
        // member who simply hasn't scanned is 'not_recorded', not 'absent'.
        // After a real close every eligible member has a present/system_absence
        // record, so 'not_recorded' only ever shows before close.
        status: current?.status ?? 'not_recorded',
        scannedAt: current?.scannedAt ? new Date(current.scannedAt).toISOString() : null,
        source: current?.source ?? '',
      };
    });

    // B3: append one row per unexpected / lookup_error scan (null ltiUserId) so
    // an off-roster student who scanned is not omitted from the export entirely.
    for (const r of records.filter((rec) => !rec.ltiUserId)) {
      exportRows.push({
        ltiUserId: '',
        institutionalId: r.institutionalId,
        displayName: '',
        status: r.status,
        scannedAt: r.scannedAt ? new Date(r.scannedAt).toISOString() : null,
        source: r.source ?? '',
      });
    }

    reply.header('Content-Type', 'text/csv; charset=utf-8');
    return buildAttendanceSessionCsv(exportRows);
  });
}

function groupRecordsByUser(records: AttendanceRecordRow[]): Map<string, AttendanceRecordRow[]> {
  const byUser = new Map<string, AttendanceRecordRow[]>();
  for (const record of records) {
    if (!record.ltiUserId) continue;
    const list = byUser.get(record.ltiUserId) ?? [];
    list.push(record);
    byUser.set(record.ltiUserId, list);
  }
  return byUser;
}
function mapCurrent(r: AttendanceRecordRow | null) {
  return r ? serializeRecord(r) : null;
}
