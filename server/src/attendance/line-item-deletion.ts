// server/src/attendance/line-item-deletion.ts
//
// The worker's line-item-deletion pass (spec §25.11, §27.1, §28). Drains due grade_line_items
// deletion requests: for each course, mint ONE AGS token (lineitem scope only), DELETE the
// cumulative line item, and on success remove the local grade_line_items row under a re-checked
// per-course advisory lock. Retryable failures (429 / 5xx / network / 401) back off with jitter up
// to MAX_GRADE_SYNC_ATTEMPTS, then terminally fail; permanent 4xx fails immediately. Every terminal
// outcome writes an audit row. Canvas 404 = the line item is already gone = success.
//
// Invoked by server/src/worker.ts BEFORE processGradeSyncJobs so a course marked for removal loses
// its column before any stray score post. NOT wired into the Fastify web process.
//
// Like claimDueJobs (grade-sync-store.ts), this pass assumes a single worker process:
// claimDueLineItemDeletions is a plain SELECT -- no `FOR UPDATE SKIP LOCKED`, no status flip -- so
// two overlapping passes would claim the same due rows. That's benign here: a second Canvas DELETE
// against an already-removed line item 404s (success), and a second finalize's re-check (request
// still pending + still the same line item, spec fix above) just no-ops. The residual risk under
// multi-replica overlap -- a DELETE issued from a row read outside the per-course advisory lock
// removing a column whose fresh scores already reached `synced` between the read and the DELETE --
// is out of scope here, same as grade-sync-store.ts already declares for AGS score posts.
//
// One non-obvious fact the whole design leans on: when the finalize aborts (cancelled, or an
// identity mismatch), the local grade_line_items row can be left pointing at a Canvas line item that
// this pass just deleted -- e.g. a concurrent cancel clears only the delete_* columns, not
// canvasLineItemId/Url. That's not a stuck state: the next close/restore's recompute goes through
// ensureLineItem, which always re-checks against Canvas by tag/resourceId and upserts whatever it
// finds (or creates), so a stale/deleted line item id there heals itself on the next grade-relevant
// event. That fact currently lives only in a test (line-item-deletion.test.ts).

import { eq, sql } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import { auditEvents, gradeLineItems } from '../database/schema.js';
import type { ToolSigningKey } from '../lti/signing-keys.js';
import { AGS_LINEITEM_SCOPE } from '../lti/scopes.js';
import { getAccessToken, clearAccessTokenCache } from '../lti/token-client.js';
import { deleteLineItem } from '../lti/ags.js';
import { loadCourseAgsContext } from './ags-course-context.js';
import { computeBackoff, MAX_GRADE_SYNC_ATTEMPTS } from './grade-sync-store.js';
import {
  claimDueLineItemDeletions,
  markLineItemDeletionRetry,
  markLineItemDeletionFailed,
} from './line-item-deletion-store.js';

export interface ProcessLineItemDeletionsDeps {
  signingKey: ToolSigningKey;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  rand?: () => number;
  maxRows?: number;
  shouldStop?: () => boolean;
}

export interface ProcessLineItemDeletionsResult {
  processed: number;
  deleted: number;
  retried: number;
  failed: number;
}

export async function processLineItemDeletions(
  db: Database,
  deps: ProcessLineItemDeletionsDeps,
): Promise<ProcessLineItemDeletionsResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now?.() ?? new Date();
  const rand = deps.rand ?? Math.random;
  const result: ProcessLineItemDeletionsResult = { processed: 0, deleted: 0, retried: 0, failed: 0 };

  const due = await claimDueLineItemDeletions(db, deps.maxRows ?? 50);

  for (const row of due) {
    if (deps.shouldStop?.()) break;
    result.processed += 1;
    const courseId = row.courseId;
    const ctx = await loadCourseAgsContext(db, courseId);

    // No registration => cannot mint a token. Treat as retryable (config/replication lag).
    if (!ctx) {
      await scheduleRetryOrFail(db, row, 'ags:no-context', now, rand, result, null);
      continue;
    }

    const registration = {
      id: ctx.registration.id,
      clientId: ctx.registration.clientId,
      tokenEndpoint: ctx.registration.tokenEndpoint,
      tokenAudience: ctx.registration.tokenAudience,
    };
    const scopes = [AGS_LINEITEM_SCOPE];
    const mintToken = () => getAccessToken(registration, scopes, { signingKey: deps.signingKey, fetchImpl });

    let token: string;
    try {
      token = await mintToken();
    } catch {
      await scheduleRetryOrFail(db, row, 'ags:token', now, rand, result, ctx.institutionId);
      continue;
    }

    let authRetried = false;
    const remintOnce = async (): Promise<boolean> => {
      if (authRetried) return false;
      authRetried = true;
      clearAccessTokenCache(registration.id, scopes);
      try {
        token = await mintToken();
        return true;
      } catch {
        return false;
      }
    };

    let del = await deleteLineItem(row.canvasLineItemUrl, token, { fetchImpl });
    if (!del.ok && del.error.kind === 'auth' && (await remintOnce())) {
      del = await deleteLineItem(row.canvasLineItemUrl, token, { fetchImpl });
    }

    if (del.ok) {
      // Finalize under a per-course advisory lock and re-check the request: a concurrent
      // close/restore may have cancelled it (and enqueued fresh work) while the DELETE was in
      // flight -- if so, leave the row, don't undo the cancel. It's not enough to check that a
      // request is still pending, though: a cancel followed by a recompute that recreates the line
      // item (line item B), followed by a fresh removal request, would leave `current` pointing at B
      // with deleteRequestedAt set again -- deleting that row would audit `grade_line_item_deleted`
      // against the OLD (row.canvasLineItemId) id while Canvas still holds column B with no local
      // row and no pending request. So also require the row still names the line item this DELETE
      // just removed; if it doesn't, abort exactly like the cancelled case.
      const canvas404 = del.value;
      const finalized = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${courseId})::bigint)`);
        const [current] = await tx.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId));
        if (!current || current.deleteRequestedAt === null) return false;
        if (current.canvasLineItemId !== row.canvasLineItemId) return false;
        await tx.delete(gradeLineItems).where(eq(gradeLineItems.courseId, courseId));
        await tx.insert(auditEvents).values({
          institutionId: ctx.institutionId,
          courseId,
          attendanceSessionId: null,
          actorLtiUserId: null,
          eventType: 'grade_line_item_deleted',
          targetType: 'grade_line_item',
          targetId: courseId,
          newValue: { canvasLineItemId: row.canvasLineItemId, canvas404 },
          requestId: null,
        });
        return true;
      });
      if (finalized) result.deleted += 1;
      continue;
    }

    if (del.error.retryable) {
      await scheduleRetryOrFail(db, row, del.error.message, now, rand, result, ctx.institutionId);
    } else {
      await markLineItemDeletionFailed(db, courseId, del.error.message, now);
      await writeFailedAudit(db, ctx.institutionId, courseId, row.deleteAttemptCount + 1, del.error.message);
      result.failed += 1;
    }
  }

  return result;
}

async function scheduleRetryOrFail(
  db: Database,
  row: { courseId: string; deleteAttemptCount: number },
  errorCode: string,
  now: Date,
  rand: () => number,
  result: ProcessLineItemDeletionsResult,
  institutionId: string | null,
): Promise<void> {
  const attemptCount = row.deleteAttemptCount + 1;
  if (attemptCount >= MAX_GRADE_SYNC_ATTEMPTS) {
    await markLineItemDeletionFailed(db, row.courseId, errorCode, now);
    if (institutionId) await writeFailedAudit(db, institutionId, row.courseId, attemptCount, errorCode);
    result.failed += 1;
  } else {
    // computeBackoff gets the PRE-increment count, matching grade-worker.ts.
    await markLineItemDeletionRetry(
      db,
      row.courseId,
      attemptCount,
      computeBackoff(row.deleteAttemptCount, now, rand),
      errorCode,
      now,
    );
    result.retried += 1;
  }
}

async function writeFailedAudit(
  db: Database,
  institutionId: string,
  courseId: string,
  attemptCount: number,
  error: string,
): Promise<void> {
  await db.insert(auditEvents).values({
    institutionId,
    courseId,
    attendanceSessionId: null,
    actorLtiUserId: null,
    eventType: 'grade_line_item_delete_failed',
    targetType: 'grade_line_item',
    targetId: courseId,
    newValue: { attemptCount, error },
    requestId: null,
  });
}
