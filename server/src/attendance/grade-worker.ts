// server/src/attendance/grade-worker.ts
//
// The retry worker's one pass (spec §28, §35.2). Claims due pending grade_sync_jobs, and for each
// course: acquires ONE AGS token, ensures the cumulative line item ONCE, then posts each member's
// score SEQUENTIALLY (spec §28 "mostly sequential ... to avoid throttling"). Retryable failures
// (429 / 5xx / network / 401) are rescheduled with exponential-backoff-with-jitter up to
// MAX_GRADE_SYNC_ATTEMPTS, then terminally failed; permanent 4xx / bad-json fail immediately
// (spec §28 "Do not automatically retry permanent 4xx"). Every terminal outcome writes an audit row.
//
// This module is invoked by server/src/worker.ts (a standalone entrypoint) — it is NOT wired into
// the Fastify web process.

import type { Database } from '../database/client.js';
import { auditEvents, gradeLineItems, type GradeSyncJobRow } from '../database/schema.js';
import type { ToolSigningKey } from '../lti/signing-keys.js';
import { AGS_LINEITEM_SCOPE, AGS_SCORE_SCOPE } from '../lti/scopes.js';
import { getAccessToken, clearAccessTokenCache } from '../lti/token-client.js';
import { validateCanvasServiceUrl } from '../lti/service-url.js';
import { ensureLineItem, postScore, ATTENDANCE_SCORE_MAXIMUM } from '../lti/ags.js';
import { loadCourseAgsContext, type CourseAgsContext } from './ags-course-context.js';
import {
  claimDueJobs,
  computeBackoff,
  markJobFailed,
  markJobRetry,
  markJobSynced,
  MAX_GRADE_SYNC_ATTEMPTS,
} from './grade-sync-store.js';

export interface ProcessGradeSyncJobsDeps {
  signingKey: ToolSigningKey;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  maxJobs?: number;
  rand?: () => number;
  /** Cooperative cancellation — checked between courses so a SIGTERM'd worker stops cleanly. */
  shouldStop?: () => boolean;
}

export interface ProcessGradeSyncJobsResult {
  processed: number;
  synced: number;
  retried: number;
  failed: number;
}

export async function processGradeSyncJobs(
  db: Database,
  deps: ProcessGradeSyncJobsDeps,
): Promise<ProcessGradeSyncJobsResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now?.() ?? new Date();
  const rand = deps.rand ?? Math.random;
  const result: ProcessGradeSyncJobsResult = { processed: 0, synced: 0, retried: 0, failed: 0 };

  const due = await claimDueJobs(db, deps.maxJobs ?? 50);
  if (due.length === 0) return result;

  const byCourse = new Map<string, GradeSyncJobRow[]>();
  for (const job of due) {
    const list = byCourse.get(job.courseId) ?? [];
    list.push(job);
    byCourse.set(job.courseId, list);
  }

  async function writeAudit(
    eventType: 'grade_sync_completed' | 'grade_sync_failed',
    ctx: CourseAgsContext,
    job: GradeSyncJobRow,
    newValue: Record<string, unknown>,
  ): Promise<void> {
    await db.insert(auditEvents).values({
      institutionId: ctx.institutionId,
      courseId: ctx.courseId,
      attendanceSessionId: job.attendanceSessionId,
      actorLtiUserId: null,
      eventType,
      targetType: 'grade_sync_job',
      targetId: job.id,
      newValue,
      requestId: null,
    });
  }

  // Retryable failure of `job`: reschedule with backoff, or terminally fail at the attempt ceiling.
  async function scheduleRetryOrFail(ctx: CourseAgsContext, job: GradeSyncJobRow, errorCode: string): Promise<void> {
    const attemptCount = job.attemptCount + 1; // stored on the row + audit
    if (attemptCount >= MAX_GRADE_SYNC_ATTEMPTS) {
      await markJobFailed(db, job.id, errorCode, now);
      await writeAudit('grade_sync_failed', ctx, job, { ltiUserId: job.ltiUserId, attemptCount, error: errorCode });
      result.failed += 1;
    } else {
      // computeBackoff gets the PRE-increment count (2026-08-28 ruling on pre-flight note N2): a job
      // that has never been retried (job.attemptCount === 0) waits GRADE_SYNC_BASE_DELAY_MS = 5 min
      // (spec §35.2), then 10, 20, 40, 60, 60.
      await markJobRetry(db, job.id, attemptCount, computeBackoff(job.attemptCount, now, rand), errorCode, now);
      result.retried += 1;
    }
  }

  const AGS_SCOPES = [AGS_LINEITEM_SCOPE, AGS_SCORE_SCOPE];

  for (const [courseId, courseJobs] of byCourse) {
    if (deps.shouldStop?.()) break;
    const ctx = await loadCourseAgsContext(db, courseId);

    // Q3: distinguish "no URL was ever persisted" from "a malformed URL was persisted at launch" —
    // an operator chases these two differently. Both are terminal (never retried).
    const failCourse = async (code: string) => {
      for (const job of courseJobs) {
        result.processed += 1;
        await markJobFailed(db, job.id, code, now);
        if (ctx) await writeAudit('grade_sync_failed', ctx, job, { ltiUserId: job.ltiUserId, error: code });
        result.failed += 1;
      }
    };
    if (!ctx || !ctx.agsLineitemsUrl) {
      await failCourse('ags:no-lineitems-url');
      continue;
    }
    if (!validateCanvasServiceUrl(ctx.agsLineitemsUrl).ok) {
      await failCourse('ags:invalid-service-url');
      continue;
    }
    const agsLineitemsUrl = ctx.agsLineitemsUrl; // narrowed to string

    const registration = {
      id: ctx.registration.id,
      clientId: ctx.registration.clientId,
      tokenEndpoint: ctx.registration.tokenEndpoint,
      tokenAudience: ctx.registration.tokenAudience,
    };
    const mintToken = () =>
      getAccessToken(registration, AGS_SCOPES, { signingKey: deps.signingKey, fetchImpl });

    // One AGS token per course per pass (token-client caches it process-wide anyway).
    let token: string;
    try {
      token = await mintToken();
    } catch {
      for (const job of courseJobs) {
        result.processed += 1;
        await scheduleRetryOrFail(ctx, job, 'ags:token');
      }
      continue;
    }

    // B3: a 401 means our cached token was revoked/rotated. Drop it and re-mint ONCE per course per
    // pass, mirroring nrps.ts:297-300. Without this the process-global cache (token-client.ts) hands
    // the same dead token to every retry for up to an hour and walks the whole course to the ceiling.
    let authRetried = false;
    const remintOnce = async (): Promise<boolean> => {
      if (authRetried) return false;
      authRetried = true;
      clearAccessTokenCache(registration.id, AGS_SCOPES);
      try {
        token = await mintToken();
        return true;
      } catch {
        return false;
      }
    };

    // One ensureLineItem per course per pass (retried once on a 401).
    let li = await ensureLineItem(agsLineitemsUrl, token, { fetchImpl });
    if (!li.ok && li.error.kind === 'auth' && (await remintOnce())) {
      li = await ensureLineItem(agsLineitemsUrl, token, { fetchImpl });
    }
    if (!li.ok) {
      for (const job of courseJobs) {
        result.processed += 1;
        if (li.error.retryable) await scheduleRetryOrFail(ctx, job, li.error.message);
        else {
          await markJobFailed(db, job.id, li.error.message, now);
          await writeAudit('grade_sync_failed', ctx, job, { ltiUserId: job.ltiUserId, error: li.error.message });
          result.failed += 1;
        }
      }
      continue;
    }

    await db
      .insert(gradeLineItems)
      .values({
        courseId,
        canvasLineItemId: li.value.canvasLineItemId,
        canvasLineItemUrl: li.value.canvasLineItemUrl,
        resourceId: li.value.resourceId,
        tag: li.value.tag,
        scoreMaximum: li.value.scoreMaximum,
      })
      .onConflictDoUpdate({
        target: gradeLineItems.courseId,
        set: {
          canvasLineItemId: li.value.canvasLineItemId,
          canvasLineItemUrl: li.value.canvasLineItemUrl,
          resourceId: li.value.resourceId,
          tag: li.value.tag,
          scoreMaximum: li.value.scoreMaximum,
          updatedAt: now,
        },
      });

    // Scores: strictly sequential per course (spec §28).
    const lineItemUrl = li.value.canvasLineItemUrl;
    for (const job of courseJobs) {
      result.processed += 1;
      const scorePayload = {
        userId: job.ltiUserId,
        scoreGiven: job.score,
        scoreMaximum: ATTENDANCE_SCORE_MAXIMUM,
        timestamp: now.toISOString(),
      };
      let post = await postScore(lineItemUrl, token, scorePayload, { fetchImpl });
      if (!post.ok && post.error.kind === 'auth' && (await remintOnce())) {
        post = await postScore(lineItemUrl, token, scorePayload, { fetchImpl });
      }
      if (post.ok) {
        await markJobSynced(db, job.id, now);
        await writeAudit('grade_sync_completed', ctx, job, { ltiUserId: job.ltiUserId, score: job.score });
        result.synced += 1;
      } else if (post.error.retryable) {
        await scheduleRetryOrFail(ctx, job, post.error.message);
      } else {
        await markJobFailed(db, job.id, post.error.message, now);
        await writeAudit('grade_sync_failed', ctx, job, { ltiUserId: job.ltiUserId, error: post.error.message });
        result.failed += 1;
      }
    }
  }

  return result;
}
