// server/src/attendance/grade-sync-store.ts
//
// The durable grade-sync outbox (spec §28). One gradeSyncJobs row per (course, member),
// UNIQUE(course_id, lti_user_id): each session close upserts the member's latest cumulative score
// and resets the row to pending. The worker (grade-worker.ts) claims due pending rows and drives
// pending -> synced / failed. Retry timing is exponential backoff with jitter (spec §28).

import { and, asc, eq, lte, sql } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import type { Tx } from './session-lifecycle.js';
import { gradeSyncJobs, type GradeSyncJobRow } from '../database/schema.js';

export const MAX_GRADE_SYNC_ATTEMPTS = 6;
export const GRADE_SYNC_BASE_DELAY_MS = 5 * 60 * 1000; // spec §35.2 "Five-minute grade retry scheduling"
export const GRADE_SYNC_MAX_DELAY_MS = 60 * 60 * 1000;

/**
 * Exponential backoff with +/-20% jitter, capped at GRADE_SYNC_MAX_DELAY_MS.
 * `rand` defaults to Math.random; jitter factor is (rand()*2 - 1) * 0.2, so rand()===0.5 => no jitter.
 */
export function computeBackoff(attemptCount: number, now: Date, rand: () => number = Math.random): Date {
  const base = Math.min(GRADE_SYNC_BASE_DELAY_MS * 2 ** attemptCount, GRADE_SYNC_MAX_DELAY_MS);
  const jitter = base * 0.2 * (rand() * 2 - 1);
  const delay = Math.max(1000, Math.round(base + jitter));
  return new Date(now.getTime() + delay);
}

export async function upsertGradeSyncJobs(
  executor: Database | Tx,
  courseId: string,
  attendanceSessionId: string,
  scores: Map<string, { scoreGiven: number }>,
): Promise<number> {
  let count = 0;
  for (const [ltiUserId, { scoreGiven }] of scores) {
    await executor
      .insert(gradeSyncJobs)
      .values({ courseId, attendanceSessionId, ltiUserId, score: scoreGiven })
      .onConflictDoUpdate({
        target: [gradeSyncJobs.courseId, gradeSyncJobs.ltiUserId],
        set: {
          score: scoreGiven,
          attendanceSessionId,
          state: 'pending',
          attemptCount: 0,
          lastError: null,
          nextAttemptAt: sql`now()`,
          updatedAt: sql`now()`,
        },
      });
    count += 1;
  }
  return count;
}

/**
 * Pending jobs whose next_attempt_at has passed, oldest-scheduled first.
 *
 * The due-check compares next_attempt_at against the DATABASE clock (`sql`now()``), not a JS
 * `new Date()` from the calling process. Every next_attempt_at value is DB-clock-generated or
 * safely in the past: `upsertGradeSyncJobs` / the retry route write `sql`now()`; `markJobRetry`
 * writes `computeBackoff(...)` (a JS Date, but always minutes ahead, so sub-second host/VM skew is
 * irrelevant); `resetFailedJobs` writes a JS `now` that is immediately past. Comparing them against
 * DB `now()` is therefore correct and immune to clock drift between the Node process and Postgres
 * (routine after a laptop sleep/suspend, and across multiple web/worker hosts in prod).
 *
 * This is a plain SELECT, NOT a claim: it does no state transition and no `FOR UPDATE SKIP LOCKED`.
 * Running two passes concurrently would select the same rows and double-post to Canvas. The
 * single-process invariant is enforced by `npm run worker` being a one-shot entrypoint (Task 10);
 * multi-replica scheduling is a Phase 7 concern (see the Self-review note). AGS score posts are
 * idempotent-by-overwrite, so the worst case of an accidental overlap is wasted quota, not a wrong
 * grade. The name is kept as `claimDueJobs` for continuity with the Fixed contract.
 */
export function claimDueJobs(db: Database, limit: number): Promise<GradeSyncJobRow[]> {
  return db
    .select()
    .from(gradeSyncJobs)
    .where(and(eq(gradeSyncJobs.state, 'pending'), lte(gradeSyncJobs.nextAttemptAt, sql`now()`)))
    .orderBy(asc(gradeSyncJobs.nextAttemptAt))
    .limit(limit);
}

export async function markJobSynced(db: Database, jobId: string, now: Date): Promise<void> {
  await db
    .update(gradeSyncJobs)
    .set({ state: 'synced', lastError: null, updatedAt: now })
    .where(eq(gradeSyncJobs.id, jobId));
}

export async function markJobRetry(
  db: Database,
  jobId: string,
  attemptCount: number,
  nextAttemptAt: Date,
  lastError: string,
  now: Date,
): Promise<void> {
  await db
    .update(gradeSyncJobs)
    .set({ state: 'pending', attemptCount, nextAttemptAt, lastError, updatedAt: now })
    .where(eq(gradeSyncJobs.id, jobId));
}

export async function markJobFailed(db: Database, jobId: string, lastError: string, now: Date): Promise<void> {
  await db
    .update(gradeSyncJobs)
    .set({ state: 'failed', lastError, updatedAt: now })
    .where(eq(gradeSyncJobs.id, jobId));
}

export interface GradeSyncSummary {
  state: 'none' | 'synced' | 'pending' | 'failed';
  counts: { pending: number; synced: number; failed: number };
  lastError: string | null;
}

export async function getGradeSyncSummary(db: Database, courseId: string): Promise<GradeSyncSummary> {
  const rows = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId));
  const counts = { pending: 0, synced: 0, failed: 0 };
  let lastError: string | null = null;
  let lastErrorAt = 0;
  for (const row of rows) {
    counts[row.state] += 1;
    if (row.state === 'failed') {
      const at = new Date(row.updatedAt).getTime();
      if (at >= lastErrorAt) {
        lastErrorAt = at;
        lastError = row.lastError ?? null;
      }
    }
  }
  const state: GradeSyncSummary['state'] =
    rows.length === 0 ? 'none' : counts.failed > 0 ? 'failed' : counts.pending > 0 ? 'pending' : 'synced';
  return { state, counts, lastError };
}

/** Re-queue every failed job for a course (spec §25.9 retry route). Returns the number reset. */
export async function resetFailedJobs(db: Database, courseId: string, now: Date): Promise<number> {
  const reset = await db
    .update(gradeSyncJobs)
    .set({ state: 'pending', attemptCount: 0, lastError: null, nextAttemptAt: now, updatedAt: now })
    .where(and(eq(gradeSyncJobs.courseId, courseId), eq(gradeSyncJobs.state, 'failed')))
    .returning({ id: gradeSyncJobs.id });
  return reset.length;
}
