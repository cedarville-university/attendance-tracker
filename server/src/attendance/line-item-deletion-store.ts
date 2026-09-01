// server/src/attendance/line-item-deletion-store.ts
//
// All DB access for the grade_line_items.delete_* lifecycle (spec §25.11, §27.1):
//   request  -> softDeleteAttendanceSession, when a soft-delete removes the last closed session
//   cancel   -> closeAttendanceSession / restoreAttendanceSession, when closed sessions remain
//   claim    -> processLineItemDeletions (worker), drains due requests against Canvas
//   retry / fail -> processLineItemDeletions, on a failed AGS DELETE
//   re-arm   -> POST /api/attendance-sessions/:id/grade-sync, after a terminal failure
//   delete-row -> processLineItemDeletions, after a successful (or 404) AGS DELETE
//
// State on the single grade_line_items row per course:
//   delete_requested_at NOT NULL                      => removal wanted
//   + delete_next_attempt_at NOT NULL, <= now()       => due for the worker
//   + delete_next_attempt_at NOT NULL, in the future  => backing off
//   + delete_next_attempt_at NULL                     => terminal failure, awaiting a manual re-arm
//   delete_requested_at NULL (or no row)              => nothing to do

import { and, asc, eq, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import type { Tx } from './session-lifecycle.js';
import { gradeLineItems, type GradeLineItemRow } from '../database/schema.js';

type DeletionExecutor = Database | Tx;

export async function requestLineItemDeletion(
  executor: DeletionExecutor,
  courseId: string,
  actorLtiUserId: string,
  now: Date,
): Promise<{ requested: boolean; canvasLineItemId: string | null }> {
  const updated = await executor
    .update(gradeLineItems)
    .set({
      deleteRequestedAt: now,
      deleteRequestedByLtiUserId: actorLtiUserId,
      deleteAttemptCount: 0,
      deleteNextAttemptAt: now,
      deleteLastError: null,
      updatedAt: now,
    })
    .where(eq(gradeLineItems.courseId, courseId))
    .returning({ canvasLineItemId: gradeLineItems.canvasLineItemId });
  return { requested: updated.length > 0, canvasLineItemId: updated[0]?.canvasLineItemId ?? null };
}

export async function cancelLineItemDeletion(executor: DeletionExecutor, courseId: string): Promise<boolean> {
  const updated = await executor
    .update(gradeLineItems)
    .set({
      deleteRequestedAt: null,
      deleteRequestedByLtiUserId: null,
      deleteAttemptCount: 0,
      deleteNextAttemptAt: null,
      deleteLastError: null,
      updatedAt: new Date(),
    })
    .where(and(eq(gradeLineItems.courseId, courseId), isNotNull(gradeLineItems.deleteRequestedAt)))
    .returning({ id: gradeLineItems.id });
  return updated.length > 0;
}

export function claimDueLineItemDeletions(db: Database, limit: number): Promise<GradeLineItemRow[]> {
  return db
    .select()
    .from(gradeLineItems)
    .where(
      and(
        isNotNull(gradeLineItems.deleteRequestedAt),
        isNotNull(gradeLineItems.deleteNextAttemptAt),
        lte(gradeLineItems.deleteNextAttemptAt, sql`now()`),
      ),
    )
    .orderBy(asc(gradeLineItems.deleteNextAttemptAt))
    .limit(limit);
}

export async function markLineItemDeletionRetry(
  db: Database,
  courseId: string,
  attemptCount: number,
  nextAttemptAt: Date,
  lastError: string,
  now: Date,
): Promise<void> {
  await db
    .update(gradeLineItems)
    .set({ deleteAttemptCount: attemptCount, deleteNextAttemptAt: nextAttemptAt, deleteLastError: lastError, updatedAt: now })
    .where(eq(gradeLineItems.courseId, courseId));
}

export async function markLineItemDeletionFailed(
  db: Database,
  courseId: string,
  lastError: string,
  now: Date,
): Promise<void> {
  await db
    .update(gradeLineItems)
    .set({ deleteNextAttemptAt: null, deleteLastError: lastError, updatedAt: now })
    .where(eq(gradeLineItems.courseId, courseId));
}

export async function rearmLineItemDeletion(db: Database, courseId: string, now: Date): Promise<boolean> {
  const updated = await db
    .update(gradeLineItems)
    .set({ deleteAttemptCount: 0, deleteNextAttemptAt: now, deleteLastError: null, updatedAt: now })
    .where(
      and(
        eq(gradeLineItems.courseId, courseId),
        isNotNull(gradeLineItems.deleteRequestedAt),
        isNull(gradeLineItems.deleteNextAttemptAt),
      ),
    )
    .returning({ id: gradeLineItems.id });
  return updated.length > 0;
}

export async function deleteGradeLineItemRow(executor: DeletionExecutor, courseId: string): Promise<void> {
  await executor.delete(gradeLineItems).where(eq(gradeLineItems.courseId, courseId));
}

/**
 * Count of line items terminally failed at removal -- `delete_requested_at` set but
 * `delete_next_attempt_at` NULL (spec §27.1's "terminally fail ... pending a manual re-arm") -- for
 * the worker's observability gauge (spec §44). Purging a course's `grade_sync_jobs` on soft delete
 * means `getGradeSyncSummary` reports nothing for it, so this is the only signal an operator has
 * that `POST /grade-sync` needs pressing. Mirrors `countGradeJobsByState`'s cheap-aggregate shape.
 */
export async function countStuckLineItemDeletions(db: Database): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(gradeLineItems)
    .where(and(isNotNull(gradeLineItems.deleteRequestedAt), isNull(gradeLineItems.deleteNextAttemptAt)));
  return row?.count ?? 0;
}
